# Connector marketplace never seeds on first run (market API mode)

**Component:** `ConnectorService` / `ConnectorCatalogChains` / `MarketCatalogChain`
**Version observed:** WorkBuddy 5.11.3 (`com.tencent.workbuddy.mac`), macOS arm64
**Severity:** connector catalog is empty for any account that has never installed a connector
**User-visible symptom:** connector page shows `连接器不可用。` and the recommendation area stays empty

---

## 1. Symptom

Connector page permanently renders the empty state:

```
连接器不可用。
```

Refresh does nothing. Restarting does nothing. Clearing caches does nothing.

Relevant UI error:

```js
var RY = {
  CONNECTOR_CATALOG_UNAVAILABLE: `PLUGIN_RECOMMENDATION_CONNECTOR_CATALOG_UNAVAILABLE`,
  CONNECTOR_UNAVAILABLE:         `PLUGIN_RECOMMENDATION_CONNECTOR_UNAVAILABLE`,
}
```

`selectConnector()` throws `CONNECTOR_CATALOG_UNAVAILABLE` when the catalog object
itself is absent, which is the case here.

---

## 2. Evidence from logs

Startup, every launch, identical:

```
[ConnectorService] market api enabled, skip marketplace zip download on init
[ConnectorMarketplace] ledger market=workbuddy-connector-plugins-official count=0 prev=- reason=market-chain
[ConnectorService] Using marketplace URL from hardcoded fallback: ... -> .../connector-plugins.zip
[ConnectorService] Marketplace policy: reason=product-config-listener-init,
    productConfigState=resolved, cache=missing, allowCloud=true, allowFallback=true,
    selected=workbuddy-connector-plugins-official
[ConnectorMcpSnapshot] end marketplaceEntries=0 declarations=0 manifestMs=0 totalMs=0
```

Two things never appear, at any point, on any launch:

- `[ConnectorMarketplace] loaded format=... entries=...` — the scan never matched a directory
- `[MarketInspector] installed=... updated=...` — the inspection never finished

`totalMs=0` on every snapshot is the tell: `scan()` walked zero candidate directories
in zero milliseconds.

Note on log reading: the trailing `unchanged` in the ledger line (`reason=market-chain unchanged`)
is a log-noise suffix appended when the scan result is byte-identical to the previous one:

```js
let c = `[ConnectorMarketplace] ledger market=${e} count=${r.size} prev=${i?.size ?? '-'} reason=${this.loadReason}...`;
this.deps.logger.info(s ? c : `${c} unchanged`);
```

It is **not** a "skip because nothing changed" decision. The actual reason string is just `market-chain`.

---

## 3. Root cause

The client has two catalog chains and picks one at startup:

```js
ConnectorCatalogChains = class {
  current(){ return this.deps.isMarketApiEnabled() ? this.deps.market : this.deps.legacy }
}
```

`isMarketApiEnabled()` is true here, so the **market** chain is used. That chain never
lays down a catalog:

### 3.1 The market chain explicitly skips the download

```js
MarketCatalogChain = class {
  // host only exposes: getLogger, loadMarketplace, reportMarketplaceFormat,
  //                    adoptMarketplaceDirectory, runMarketInspection, readLedgerInstallPaths
  async syncOnInit(){
    logger.info('market api enabled, skip marketplace zip download on init'),
    await this.host.loadMarketplace(),
    this.host.reportMarketplaceFormat(),
    this.host.adoptMarketplaceDirectory({ contentChanged:false }).catch(...),
    this.host.runMarketInspection('init').catch(...)
  }
  refresh(e){ return this.host.runMarketInspection(e) }   // inspection again, not a download
}
```

It has **no download capability at all** — the injected host has neither
`getSourceForCurrentPolicy` nor `requestSync`.

### 3.2 The inspection it delegates to cannot seed anything

```js
async function inspectMarketplace(e){
  let t = e.getInstalled(), n = { updated:[], delisted:[], unchanged:[] };
  if (t.size === 0) return n;          // <-- zero installs => returns immediately
  ...
  e.logger.info(`[MarketInspector] installed=...`)   // never reached
}
```

`getInstalled()` is derived from the current snapshot
(`snapshot.manifest.connectors` where `installed` is true). On a machine that has never
installed anything, that set is empty, so the function returns on line 2 and the
`[MarketInspector]` log line never prints. This matches the logs exactly.

`inspectMarketplace` is a **version/delisting sweep over already-installed packages**.
It was never a catalog bootstrap.

### 3.3 The scan only reads disk, and the disk is empty

```js
async scan(){
  let t = Ol;                                    // empty catalog
  for (let n of this.deps.getBaseDirs()) {
    let r = await detectConnectorMarketplaceFormat(n);
    if (!r && await this.hasLedgerEntries(n)) r = 'plugin';
    if (!r) continue;                            // no manifest on disk => skip
    ...
    break;
  }
  return t;                                      // still empty, in 0 ms
}
```

`getBaseDirs()` = `marketplaceDirCandidates()`, whose first entry is
`pluginMarketplaceDir(name)` = `~/.workbuddy/connectors-marketplace-sources/<marketplaceName>`.
On this machine that path did not exist. Hence `cache=missing`, `format=null`, `totalMs=0`.

### 3.4 Adoption is a no-op without a directory

```js
async adoptMarketplaceDirectory(e){
  let n = this.host.getMarketplaceStore().snapshot();
  if (!t || n.format !== 'plugin' || !n.manifest || ...) return;   // format is null => return
  ...
}
```

### 3.5 Catalog reads bottom out in that same empty snapshot

```js
readLocalManifest(){
  let e = this.catalogSnapshot().manifest;    // === marketplaceStore.snapshot().manifest
  ...
}

async getAllConfigs(e){
  await this.host.getLifecycle().ensureInitialized();
  let t = this.host.getManifestReader().readLocalManifest();
  if (!t?.connectors) return [];              // => UI receives zero connectors
  ...
}
```

### 3.6 The legacy chain, by contrast, does have the bootstrap

```js
LegacyCatalogChain = class {
  syncOnInit(){ return this.syncContent() }

  async syncContent(){
    ... await this.host.loadMarketplace();
    if (this.host.isLoaded()) { /* cached-startup -> mode:'update' */ return }

    // no cache:
    let e = this.getSourceForCurrentPolicy('startup-no-cache');
    if (!e) throw Error('Connector marketplace source is unavailable');
    await this.requestSync(e, { mode:'install', reason:'startup-no-cache' });   // downloads + extracts + swaps dir
  }
}
```

### Summary of the break

| Step | legacy chain | market chain |
|---|---|---|
| load marketplace from disk | yes | yes |
| **seed catalog when disk is empty** | **yes** (`startup-no-cache` -> `mode:'install'`) | **no** |
| update when disk is present | yes (`cached-startup` -> `mode:'update'`) | no |
| relies on | local zip catalog | cloud market API |
| catalog read path in UI | local manifest | **local manifest** (same as legacy) |

The market chain removed the download but kept the same local-manifest read path.
`getAllConfigs()` never consults the cloud market API, so nothing fills the gap.
**The `zip download` and the `catalog read` were decoupled in opposite directions.**

---

## 4. Reproduction

Any clean profile reproduces it:

```bash
mv ~/.workbuddy/connectors-marketplace-sources /tmp/mk.bak   # simulate zero install
# fully quit and relaunch
grep 'skip marketplace zip download on init' ~/.workbuddy/logs/daemon.log | tail -1
grep 'ConnectorMcpSnapshot' ~/.workbuddy/logs/daemon.log | tail -1
# => marketplaceEntries=0 declarations=0 manifestMs=0 totalMs=0
```

No account type, network state, or cache state changes the outcome. Confirmed on this
machine: the account is an enterprise-tier identity with `enterpriseId` unset, but the
same shape occurs for `personal` because the branch never looks at identity.

---

## 5. Fixes

### Option A (recommended, matches market-API intent)

Make the catalog read fall back to the cloud market API when the local manifest is
absent. `MarketCatalogService` already exposes the paginated client
(`readMarketPage` / `getConnectors`), so the pieces exist:

```js
async getAllConfigs(e){
  await this.host.getLifecycle().ensureInitialized();
  let t = this.host.getManifestReader().readLocalManifest();

  if (!t?.connectors) {
    const remote = await this.host.getMarketCatalog()
      .getConfigs({ allowCloud: true, allowlistOnly: e?.allowlistOnly });
    if (remote?.length) return remote;
    return [];
  }
  ...
}
```

Caveat: `getAllConfigs()` is currently synchronous in shape; this makes it await a
paginated call, so callers need to tolerate an extra round trip.

### Option B (smallest diff, restores the missing bootstrap)

Either inject the missing dependencies into `MarketCatalogChain` and seed there:

```js
new MarketCatalogChain({
  ...existing,
  getSourceForCurrentPolicy: e => this.getSourceForCurrentPolicy(e),
  requestSync: (src, opts) => this.requestSync(src, opts),
})

async syncOnInit(){
  this.host.getLogger().info('... skip marketplace zip download on init');
  await this.host.loadMarketplace();
  this.host.reportMarketplaceFormat();

  if (this.host.getMarketplaceStore().snapshot().format === null) {
    const src = this.host.getSourceForCurrentPolicy('startup-no-cache');
    if (src) {
      this.host.getLogger().warn('marketplace catalog empty; seeding from ' + src.marketplaceName);
      await this.host.requestSync(src, { mode:'install', reason:'startup-no-cache' });
      await this.host.loadMarketplace();
    }
  }

  this.host.adoptMarketplaceDirectory({ contentChanged:false }).catch(...);
  this.host.runMarketInspection('init').catch(...);
}
```

Or, at the routing level, let the market chain hand back to legacy when it has nothing:

```js
current(){
  const chain = this.deps.isMarketApiEnabled() ? this.deps.market : this.deps.legacy;
  return chain;
}

async syncOnInit(){
  const chain = this.current();
  await chain.syncOnInit();
  // after the market chain initialised, if the catalog is still empty, seed via legacy
  if (this.deps.isMarketApiEnabled() && this.deps.store.snapshot().format === null) {
    await this.deps.legacy.syncContent();
  }
}
```

### Option C (mitigation only)

Emit a metric + visible state instead of a silent empty catalog:

```js
if (t.size === 0) {
  e.logger.info('[MarketInspector] skipped: no installed packages');
  reportMetric('connector.market.inspect_skipped_empty', { reason: e });
  return n;
}
```

This does not fix the catalog, but it makes the failure observable. Right now the only
trace is `marketplaceEntries=0`, which looks like a healthy empty state.

### Also worth fixing

`MarketCatalogChain.syncOnInit()` logs a **hard-coded** claim:

```js
this.host.getLogger().info('market api enabled, skip marketplace zip download on init')
```

It prints unconditionally, even if `isMarketApiEnabled()` were false for some other
reason. That log actively misleads triage — it asserts a precondition it never checks.
Suggest logging the actual resolved value.

---

## 6. Local workaround (used on the affected machine)

Seed the first `marketplaceDirCandidates()` entry manually. Equivalent to what
`downloadAndReplace()` does: download -> extract -> atomic directory swap.

```bash
bash fix-connector-market.sh --check   # report state
bash fix-connector-market.sh           # seed if missing
bash fix-connector-market.sh --force   # refresh
```

Result:

```
~/.workbuddy/connectors-marketplace-sources/workbuddy-connector-plugins-official/
├── .codebuddy-plugin/marketplace.json   name=workbuddy-connector-plugins-official plugins=641
└── connectors/                          641 packages, 123 MB
```

Expected log after a full restart:

```
[ConnectorMarketplace] loaded format=plugin dir=.../workbuddy-connector-plugins-official entries=641
[ConnectorMcpSnapshot] end marketplaceEntries=641 declarations=... totalMs=<non-zero>
```

This is a workaround, not a fix: it has to be repeated on every clean profile, and any
client upgrade that rewrites the marketplace directory undoes it.

---

## 7. Unverified assumptions

- The cloud market API itself was not exercised (`readMarketPage` never appears in logs,
  so it is unknown whether it would succeed on this account). Option A depends on it.
- `enterpriseId` being unset was investigated and ruled out as a cause: the failing
  branch never reads account identity.
