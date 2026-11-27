# Design

## The problem with the previous approach

`server/scripts/seed_mcp_market.py` read `~/.workbuddy/connectors-marketplace-sources/...` and
copied 536 entries into the `mcp` table. Three properties made that unacceptable:

1. **It is not in the repository.** Checkout the code on another machine and the market is empty, so
   the feature only exists on the machine of whoever ran the script.
2. **It is not ours.** The directory is a product artifact of another application. A listing of 641
   connectors is not source code we can redistribute, even though each individual field is a fact.
3. **It cannot be corrected.** A publisher fixing a typo could not reach us; we would have to ship a
   release with a new copy of their row.

A loader fixes all three by storing _pointers and rules_ instead of _contents_.

## Three constraints, made mechanical

A loader without these is a shell that parses JSON.

### 1. Namespace proof

`name` must be reverse DNS (`io.example/weather`), `publisher.namespace` must equal its prefix, and
`publisher.verifiedBy` must name the mechanism.

- `NAMESPACE_MISMATCH` is an **error**: the entry cannot be installed.
- `verifiedBy: "manual"` or absent is `SELF_ASSERTED`, a **warning**: the identity is claimed, not
  proven.

Without this layer the index is a noticeboard anyone can write on. With it, claiming
`io.example/weather` requires controlling `io.example`, or at least lying in a field that says how you
proved it. The loader cannot verify a DNS record offline, and does not pretend to: `verify --strict`
passing means _format and declarations are self-consistent_, not _identity is proven_.

### 2. A complete run instruction

WorkBuddy manifests may omit `command` because the loader and the runtime are the same vendor. An
MCP server is an external process; omitting one field means the user cannot start it at all. Missing
`run.command` (stdio) or `run.url` (http) is `NO_RUN_INSTRUCTION`, an error.

### 3. Declared permissions

Missing permissions only warn, but `add` prints `permissions: UNDECLARED` where a host can see it and
refuse. A loader that hides this makes an undeclared filesystem server indistinguishable from a
weather API.

## The only data in the repository

`sources.default.json` is 9 lines describing **what to read**, not **what exists**:

```json
[
  {
    "id": "official-registry",
    "type": "registry",
    "url": "https://registry.modelcontextprotocol.io/v0/servers?limit=100"
  },
  {
    "id": "local-examples",
    "type": "marketplace",
    "path": "./examples/marketplace.json"
  }
]
```

Removing a line withdraws a source; nobody loses data. A publisher editing their own server does not
require a release from us.

## Two checks the official registry does not do

The registry documentation states it does not verify that a remote URL belongs to the publisher. Both
checks are offline and free, and they catch the most valuable class of impersonation:

- `REMOTE_DOMAIN_MISMATCH` — `com.acme/xxx` advertising an endpoint on `evil.com`.
- `ENTRY_PACKAGE_MISMATCH` — the launch arguments no longer contain the declared package. A cheap
  pointer-rot detector, not a security control.

`examples/servers/drift.json` is deliberately broken:

```
warn  drift.json UNPINNED_PACKAGE: no package version; the pointer can drift under the user
warn  drift.json ENTRY_PACKAGE_MISMATCH: launch command does not reference any declared package identifier
warn  drift.json NO_PERMISSIONS: no permissions declared
warn  drift.json SELF_ASSERTED: identity is self-asserted, not proven
```

## Variables never enter headers

`variables` are substituted into the URL path only. A tenant slug sent as an auth header returns 401,
and the user sees "cannot connect" with no way to diagnose it. Emitting `${input:tenant}` costs one
prompt; emitting `x-tenant: acme` costs a support ticket. `VARIABLE_IN_HEADER` is an error in all
three renderers, and a test asserts it even when a value was supplied.

Related: a variable may not move the origin (`VARIABLE_IN_HOST`), because a templated host turns a
manifest into a redirector.

Trailing constraint kept: `${ENV_NAME}` is an environment reference, not a template variable, so
`headers: { "x-api-key": "${WEATHER_API_KEY}" }` is legal and becomes a declared input.

## Who publishes: the loader is ours, the entries are theirs

Saying "implement a loader instead of maintaining data" is incomplete unless a publisher can actually
publish. Three pieces make the split real:

- `schema/mcp-manifest.schema.json` — the contract, usable for editor completion and CI.
- `docs/PUBLISHING.md` — the publisher's path: `init` → `verify --strict` → `index` → host → hand out
  the index URL.
- `marketplace` sources accept a local `path` **or** a hosted `url`. Relative entries resolve against
  the index location, so a publisher can move from a laptop to a CDN without consumers editing
  anything.

The consequence worth stating plainly: nothing in this repository contains a publisher's server, so
their release is not our release. That is the trade we accepted when we stopped seeding a catalog.

## What this model cannot buy

Written down so nobody promises otherwise.

- **Discovery.** There is no central catalog, so there is no "trending this week". You still need an
  entry point, but that entry point is an **index** (who published a manifest) rather than a
  **catalog** (what servers exist). The former is a few dozen lines; the latter is a team.
- **A quality floor.** The loader guarantees "the format is right and the namespace matches". It
  cannot guarantee "this server is good". Quality requires review, which is exactly the curatorial
  path. Pick one; do not claim both.
- **Pointer liveness.** `@modelcontextprotocol/server-github` was archived in April 2025. We can pin
  a version and detect when the arguments stop matching the declared package. We cannot keep it
  alive.

## Real-network findings

Checked against `registry.modelcontextprotocol.io` on 2026-11-24 with `list --registry`:

- 20 pages x 100 = **2000 rows**, `metadata.nextCursor` present after the last page (crawl truncated).
- Those 2000 rows are **471 servers**: the registry publishes one row per version, and one publisher
  alone accounted for 980 rows.
- Cursor format is `name:version`, so pagination is version-granular, not server-granular.

Consequences now implemented: collapse by name to the newest semver (`SOURCE_DUPLICATES`), and warn
when the crawl stops at the page cap (`SOURCE_TRUNCATED`) instead of silently returning a partial
market.

Still open: a full crawl needs either a much higher page cap or cursor persistence, and the per-version
pagination means "all pages" is not the same as "all servers".

## The bridge into the `mcp` table

The loader and the database need to meet somewhere, and the seam decides who owns which rule.

`catalog` is that seam: it emits the ten columns `seed_mcp_market.py` inserts and nothing else. The
loader keeps every manifest rule; the seed script keeps every schema rule; neither reads the other's
data structure. Two consequences worth stating:

- **The seed script validates the file, not the manifest.** A catalogue is a file on disk. It can be
  edited by hand, produced by an older loader, or fetched from somewhere. `install_command` is
  re-checked for a `command` or a `url`, `type` is **derived** from that presence rather than trusted,
  and duplicate keys are dropped with a line of output. A row that cannot connect is worse than a
  missing row: it looks installed and fails at connect time with an empty tool list.
- **The category keyword table stays in one place.** A manifest may declare `category`; when it does
  not, `catalog` emits `null` and the seed script classifies. Copying the Chinese keyword table into
  JavaScript would have guaranteed drift, and the two copies would disagree exactly when it mattered.

Three refusals, each for a different reason:

| refusal        | why it is not just a warning                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| `INVALID`      | the manifest cannot describe a runnable server at all                             |
| `UNRUNNABLE`   | the URL needs a value only the end user has; a catalogue cannot prompt            |
| `ENV_REQUIRED` | written, but with an empty value — a literal `${VAR}` would be sent as the secret |

The last one is the interesting case. There is no good automatic answer: inventing a value produces a
401 the user cannot diagnose, and dropping the record hides a working server. An empty value in a form
is visible; a literal `${WEATHER_API_KEY}` in an `Authorization` header is not.

Finally, the default. `--marketplace` still imports a WorkBuddy-style directory, but it is now an
argument you type, not a default you inherit. With no flag the script seeds three curated rows, so a
fresh checkout gets a working market page and no third-party data.

## What the code says (read, not assumed)

Five claims, each with the line that supports it. Anything not in this table is still a guess and
has to be labelled as one.

| claim                                    | evidence                                                                                                                                                    | consequence                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mcp_env` is never serialized            | `McpOut` declares it commented out (`server/app/model/mcp/mcp.py:87`)                                                                                       | filling that table changes nothing the UI can see                                            |
| the API loads it anyway                  | `selectinload(Mcp.envs)` in list and detail (`mcp_controller.py:55,77`)                                                                                     | the intent existed; the serializer was switched off                                          |
| the env form reads `install_command.env` | `Object.keys(activeMcp.install_command.env)` (`MCPEnvDialog.tsx:109-118`, `AddWorker/index.tsx:194`, `ToolSelect.tsx:441`, `IntegrationList/index.tsx:178`) | keys with empty values **are** the wiring protocol today, not a compromise                   |
| no version column exists                 | no `version` field in `mcp.py` or `mcp_user.py`                                                                                                             | "which release did I copy from" is unanswerable by the schema; the version stays in the file |
| headers used to die at install           | `McpUserService.install` copied `command`/`url`/`args`/`env` only; `McpUser` had no headers column                                                          | **fixed** — see "The header chain" below                                                     |

Three corrections this forced:

1. **The earlier advice to move `${VAR}` into `mcp_env` was wrong for this codebase.** The form does
   not read that table, so a row described only by `mcp_env` would render _no fields at all_. An empty
   value plus `pending_env` is the only shape the current UI turns into a visible input.
2. **"Two sources of truth for env" is not a live risk yet.** There is one truth
   (`install_command.env`) and one dead table (`mcp_env`). The moment `envs` is uncommented, the
   assertion `keys(install_command.env) == {mcp_env.env_key}` becomes mandatory — writing it earlier
   would only assert something about data nobody reads.

There is also a hint channel that would be a trap: the form's tooltip is the value with `{{` / `}}`
stripped (`MCPEnvDialog.tsx:116`). Publishing `"API_KEY": "{{get one at example.com}}"` would render a
useful hint and, on the gateway install path — which never opens that dialog
(`ConnectorGateway.tsx:1286-1311`) — send the literal string as the env value. So the loader writes an
empty value and keeps the hint in `pending_env`, where it is data instead of a loaded gun.

That last sentence is now out of date in one respect: the gateway path **does** open the dialog when a
header needs a value. The reasoning survives — the loader still must not publish the hint — but the
claim "this path never asks" would be a lie if left as written.

## The header chain, end to end

A remote MCP behind an API key needs a header on every request. The chain that carries it, and what
each link now does:

| link                            | file                                   | behaviour                                                                     |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| catalogue → row                 | `mcp_user_service.install`             | copies `headers`, blanks `{{hint}}` values, refuses headers on a stdio server |
| row → form                      | `MCPEnvDialog`                         | renders one input per header key, submits them back into `install_command`    |
| gateway → dialog                | `ConnectorGateway`                     | `needsHeaderValues()` routes to the dialog instead of installing blind         |
| renderer → Brain                | `api/brain.ts`                         | throws before the request when a header is empty, naming it                   |
| Brain → `~/.eigent/mcp.json`    | `backend/app/service/mcp_config.py`    | refuses empty values and leftover hints; passes verified headers through      |
| config → client                 | camel `MCPClient` (unchanged)          | already forwarded `headers` to `streamablehttp_client`                        |

The **acceptance criterion was not "the column exists"**. It was: a remote server that rejects
unauthenticated requests is installed through this chain, the real client connects, and the server
answers 200. `backend/tests/app/service/test_mcp_config_headers.py` does exactly that against a live
`FastMCP` streamable-http server wrapped in an `x-api-key` gate, and asserts on the server's own
counters that no unauthenticated request was sent. `server/tests/test_mcp_user_headers.py` covers the
store half and ends at the shape the two halves agree on:

```json
{ "url": "https://...", "headers": { "x-api-key": "" } }
```

Keys intact, values empty. Filling them in is the form's job, not the loader's.

Three things that were easy to get wrong, and where they are enforced:

1. **A column without a consumer is worse than no column.** That was the `mcp_env` lesson. The header
   value is read by `MCPEnvDialog`, by `ConnectorGateway.installMarketItem`, by `api/brain.ts`, by
   `add_mcp`, and finally by camel. Every one of those had to change in the same commit; stopping
   after the migration would have produced the exact failure this document already describes.
2. **Fixing the writer does not fix the data already written.** Rows created before this change can
   still hold `{{...}}` in `env`, and those users are sending a sentence as a key right now.
   `server/scripts/scan_mcp_placeholders.py` finds them in both the database and the live
   `mcp.json`, and `--fix` blanks the value while keeping the key. Read-only by default.
3. **A per-row `try` can swallow a contract check.** `CatalogSchemaMismatch` inheriting `RuntimeError`
   protects it only until someone writes `except Exception` for resilience. The unknown-field check
   therefore moved into `assert_known_fields()`, which runs over the whole batch *before* any row is
   normalised, printed or counted — so no base class choice can hide it.

What this does **not** fix: `mcp` and `mcp_user` still have no `version` column, so an installed copy
cannot say which release it came from. That is a separate migration (nullable, no backfill, NULL shown
as "version unknown"), and it would not have fixed a single 401.

## The file and the table are held to one contract

Every key in `rows.json` must be one of the ten columns or one of four provenance fields
(`manifest`, `version`, `pending_env`, `source`). A key outside that set is a **hard failure**:

```
refusing to seed: unknown field(s) ['tools'] in weather: the catalogue and this table disagree.
```

A whitelist that drops unknown keys is a filter, and a filter is the worst place to lose data: the
loader reports a complete row, the database reports a successful insert, the logs look healthy, and
the only symptom is a missing form field three layers away. The seed script therefore raises
`CatalogSchemaMismatch` and stops, while the provenance fields are named explicitly so that "keep it
in the file, do not insert it" is a decision instead of an accident.

`version` is the clearest case. The table cannot hold it, and the install copy cannot record where it
came from. Losing it would be silent; keeping it in the file costs nothing and is the input any future
migration needs.
