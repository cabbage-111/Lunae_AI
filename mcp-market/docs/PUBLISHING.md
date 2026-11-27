# Publishing an MCP server

The repository does not host your server and does not maintain a catalog of servers. It ships a
loader and this contract. You publish; anyone who chooses to read your index gets your server.

## 1. Write the manifest

```bash
node src/cli.js init ./my-server
```

Then replace every example value. The four non-negotiable fields are `name`, `version`, `publisher`,
`run`; `schema/mcp-manifest.schema.json` gives you editor completion and CI validation if you point
your tooling at it.

```json
{
  "$schema": "https://raw.githubusercontent.com/<you>/mcp-market/main/schema/mcp-manifest.schema.json",
  "name": "com.acme/notes",
  "version": "0.4.1",
  "publisher": {
    "namespace": "com.acme",
    "displayName": "Acme",
    "url": "https://acme.com",
    "verifiedBy": "dns-txt"
  },
  "run": { "type": "http", "url": "https://mcp.acme.com/{tenant}/mcp" },
  "variables": [{ "name": "tenant", "description": "Your Acme tenant slug" }],
  "permissions": { "network": ["mcp.acme.com"] }
}
```

## 2. Self-check before publishing

```bash
node src/cli.js verify ./my-server/mcp-manifest.json --strict
```

`--strict` fails on warnings, which is what you want before publishing. A passing run means the
format is right and the declarations are self-consistent. It does **not** mean an identity was proven;
the loader is offline.

## 3. Build the index

```bash
node src/cli.js index ./public/mcp/servers --out ./public/mcp/marketplace.json
```

The index lists paths **relative to the index file**, so keep the manifests under the directory you
serve and they stay valid wherever it is hosted:

```json
{ "name": "acme", "servers": ["./servers/notes.json"] }
```

`index` refuses to write when a manifest has an error. `--skip-invalid` publishes the valid subset and
names the rest.

## 4. Host it

Any static host works: GitHub Pages, S3, an object store, your own domain. You need two stable URLs:

- the manifest, e.g. `https://acme.com/mcp/servers/notes.json`
- the index, e.g. `https://acme.com/mcp/marketplace.json`

No registration, no pull request to this repository.

## 5. Let others read it

A consumer adds your index to their sources file:

```json
[
  {
    "id": "acme",
    "type": "marketplace",
    "url": "https://acme.com/mcp/marketplace.json"
  }
]
```

```bash
node src/cli.js list --source ./sources.json
node src/cli.js add com.acme/notes -t vscode --source ./sources.json
```

Relative entries are resolved against the index URL, so moving the index to a CDN requires no edit.

## Identity: what `verifiedBy` claims

| value             | what it means                                            |
| ----------------- | -------------------------------------------------------- |
| `dns-txt`         | a TXT record at the namespace domain publishes a token   |
| `github-org`      | the namespace prefix maps to a GitHub org you administer |
| `signed-manifest` | the manifest carries a signature over its own bytes      |
| `sigstore`        | the manifest was signed through a transparency log       |
| `manual`          | nothing is proven; the claim is self-asserted            |

The loader only checks that `verifiedBy` is one of these and that `publisher.namespace` equals the
prefix of `name`. It reports `SELF_ASSERTED` for `manual` (or absent) and lets the host decide whether
to install anyway. Overclaiming is visible, not undetectable.

## Rules that will reject your manifest

1. `name` must be reverse DNS, and `publisher.namespace` must equal its prefix. Otherwise
   `NAMESPACE_MISMATCH`, an error.
2. A stdio manifest must declare `run.command`; an http manifest must declare `run.url`. Otherwise
   `NO_RUN_INSTRUCTION`, an error.
3. Every package must be pinned to an exact version, and the launch command must still reference the
   declared identifier. Otherwise `UNPINNED_PACKAGE` / `ENTRY_PACKAGE_MISMATCH`.
4. Declare `permissions`. Missing means `UNDECLARED`, and a host may refuse it.
5. `{variable}` placeholders are for the URL path only. A templated header is `VARIABLE_IN_HEADER`, an
   error. `${ENV_NAME}` is the only supported reference inside a header.

## Updating and withdrawing

Edit the manifest and its version, rebuild the index, re-upload. Consumers see the new version on
their next `list`, because they read your file rather than our copy. Removing an entry from the index,
or returning 404, withdraws it. There is no deprecation process to negotiate with us; that is the
trade-off for having no central curator.
