# mcp-market

A manifest-first MCP index. The repository stores **where to read** and **how to judge**, never a
copy of someone else's catalog.

It does two jobs from the same data: render a client config for one server (`add`), and project
every reachable server into the rows the `mcp` table holds (`catalog`).

Zero dependencies, Node >= 22, ESM.

## Why this exists

The self-hosted server ships the `mcp` / `category` schema and nothing else, so the market page is
empty on first boot. The old fix was a seeding script that imported a third-party connector index
from a local application install (`~/.workbuddy/connectors-marketplace-sources/...`). That made one
machine look complete and every other machine empty, and it redistributed a catalog we have no
license to ship.

This module replaces that with a loader: publishers describe their own server in a manifest, the
host renders a client config from it, and the seed script reads the loader's output instead of a
directory on somebody's laptop. See [`docs/DESIGN.md`](docs/DESIGN.md) for the reasoning and what
this model deliberately cannot buy.

## Layout

```
sources.default.json      what to read (live registry + checked-in examples)
sources.local.json        offline subset: the examples only, no network
schema/                   the manifest contract publishers validate against
src/manifest.js           normalize a manifest, reverse-DNS + semver helpers
src/validate.js           the rule set, with error/warn severities
src/sources.js            registry pagination, hosted/local marketplace, registry adapter
src/emit.js               vscode | portable | link renderers
src/catalog.js            manifest -> mcp table row, plus the reasons a row is refused
src/store.js              merge into a config file, refuse duplicates
src/commands.js           list / show / add / init / index / verify / catalog
src/cli.js                argument parsing, exit codes
examples/                 three manifests: a good remote, a templated one, a broken one
docs/PUBLISHING.md        how a third party publishes without touching this repo
```

## Usage

```bash
node src/cli.js list                       # every configured source
node src/cli.js list --registry            # registry only, follow every page
node src/cli.js show io.example/weather
node src/cli.js add io.example/weather -t vscode
node src/cli.js add com.acme/notes -t portable --var tenant=acme
node src/cli.js add io.example/weather -t link
node src/cli.js add io.example/weather -t vscode --write
node src/cli.js init ./my-server
node src/cli.js verify mcp-manifest.json --strict
node src/cli.js index ./public/mcp/servers --out ./public/mcp/marketplace.json
node src/cli.js catalog --out ./rows.json --skip-invalid
```

`add` renders; `--write` (or `--config <file>`) installs. A second install of the same server is
refused until `--force`.

Targets:

- `vscode` — `{ inputs, servers }`; secrets become `${input:...}` plus a declared input.
- `portable` — `{ mcpServers }`; secrets become `${env:...}`; URL variables must be supplied.
- `link` — `vscode:mcp/install?<json>`; nothing is written.

## Publishing, not curating

There is no catalog here to submit to. A publisher runs `init`, `verify --strict`, then `index` over a
directory of manifests, uploads both the manifest and `marketplace.json` to any static host, and tells
consumers the index URL:

```json
[
  {
    "id": "acme",
    "type": "marketplace",
    "url": "https://acme.com/mcp/marketplace.json"
  }
]
```

`marketplace` sources accept either `path` (local) or `url` (hosted); relative entries resolve against
the index location. Nothing about the publisher's server lives in this repository, so their update
does not need our release. Full contract: [`docs/PUBLISHING.md`](docs/PUBLISHING.md).

## Feeding the market table

`catalog` projects every reachable manifest into the row shape
`server/scripts/seed_mcp_market.py` inserts — the same ten columns, so the seed script never needs
to know what a manifest is, and the loader never needs to know what a table is.

```bash
node src/cli.js catalog --out ./rows.json --skip-invalid
python server/scripts/seed_mcp_market.py --catalog ./rows.json          # preview
python server/scripts/seed_mcp_market.py --catalog ./rows.json --apply  # write rows
```

Or let the seed script run the loader itself:

```bash
python server/scripts/seed_mcp_market.py --from-loader --apply
python server/scripts/seed_mcp_market.py --from-loader \
    --sources mcp-market/sources.default.json --apply   # include the live registry
```

What happens to a manifest that cannot become a row:

| situation                              | result                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| validation error                       | refused; `--skip-invalid` writes the rest and lists it        |
| URL needs `{variable}` with no default | refused — no row could be installed without it                |
| `${ENV}` reference in env/headers      | row written with an empty value, reported as `ENV_REQUIRED`   |
| `title` / `category` declared          | used verbatim                                                 |
| neither declared                       | `category: null` — the seed script classifies, so the keyword |
|                                        | table stays in exactly one place                              |

The file and the table are held to one contract: every key in `rows.json` is either one of the ten
columns or one of four provenance fields (`manifest`, `version`, `pending_env`, `source`). Anything
else is a hard failure, not a dropped field:

```
refusing to seed: unknown field(s) ['tools'] in weather: the catalogue and this table disagree.
```

Transport is rewritten on the way out (`http` → `streamable_http`) because the MCP client rejects the
hyphenated spelling; a stored row has to be runnable as-is. Two namespaces publishing the same local
name get distinct keys (`weather`, `com-other-weather`) instead of one overwriting the other.

The default seed is still three curated rows. Nothing third-party is bundled:

```bash
python server/scripts/seed_mcp_market.py     # preview the starter set
```

## Exit codes

| code | meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | ok                                                               |
| 1    | rejected (invalid manifest, missing variable, duplicate install) |
| 2    | usage error                                                      |

## Rules

Errors block an install. Warnings are reported and, with `--strict`, also block.

| code                     | severity | meaning                                                  |
| ------------------------ | -------- | -------------------------------------------------------- |
| `BAD_NAME`               | error    | name is not a reverse-DNS identifier                     |
| `NAMESPACE_MISMATCH`     | error    | `publisher.namespace` does not own the name prefix       |
| `BAD_VERSION`            | error    | version is not an exact semver                           |
| `NO_RUN_INSTRUCTION`     | error    | no `run.command` (stdio) or `run.url` (http)             |
| `UNKNOWN_TRANSPORT`      | error    | not `stdio` / `http`                                     |
| `VARIABLE_IN_HOST`       | error    | a template variable moves the URL origin                 |
| `VARIABLE_IN_HEADER`     | error    | a template variable appears in a header                  |
| `BAD_URL`                | error    | `run.url` does not parse                                 |
| `MISSING_VERSION`        | warn     | no version                                               |
| `SELF_ASSERTED`          | warn     | `publisher.verifiedBy` is absent or `manual`             |
| `UNPINNED_PACKAGE`       | warn     | declared package has no exact version                    |
| `ENTRY_PACKAGE_MISMATCH` | warn     | launch command no longer references the declared package |
| `NO_PERMISSIONS`         | warn     | nothing declared under `permissions`                     |
| `REMOTE_DOMAIN_MISMATCH` | warn     | endpoint host is outside the namespace domain            |

`permissions: UNDECLARED` is printed on `add` so a host can refuse an undeclared server.

## Manifest

```json
{
  "name": "io.example/weather",
  "version": "1.2.0",
  "publisher": {
    "namespace": "io.example",
    "url": "https://example.io",
    "verifiedBy": "dns-txt"
  },
  "run": {
    "type": "http",
    "url": "https://mcp.example.io/{tenant}/mcp",
    "headers": { "x-api-key": "${WEATHER_API_KEY}" }
  },
  "variables": [{ "name": "tenant", "description": "Your tenant slug" }],
  "permissions": { "network": ["mcp.example.io"] }
}
```

Two placeholder syntaxes, deliberately different:

- `{tenant}` — a **URL path variable**, filled by `--var` or turned into a prompt. Never written into
  a header: a tenant slug sent as an auth header returns 401 and the user only sees "cannot connect".
- `${WEATHER_API_KEY}` — an **environment reference**, resolved by the host (`${input:...}` for
  `vscode`, `${env:...}` for `portable`).

## Tests

```bash
npm test        # node --test "test/*.test.js"
```

100 tests, no network: registry and hosted-marketplace tests run against a local `http` server.
The Python side of the bridge is covered by `server/tests/test_seed_catalog.py`.

## Verified against the real registry

`list --registry` was run against `registry.modelcontextprotocol.io` on 2026-11-24:

```
info  official-registry SOURCE_PAGES: 2000 row(s) over 20 page(s), 471 server(s)
info  official-registry SOURCE_DUPLICATES: 1529 version row(s) collapsed to the newest build
warn  official-registry SOURCE_TRUNCATED: stopped at 20 page(s) with more remaining; raise --max-pages
```

The registry returns **one row per version**, not per server, and `metadata.nextCursor` is a
name:version cursor. 1529 of the first 2000 rows were older builds of servers already seen. Without
collapsing, a market page shows 2000 rows that are really 471 servers.
