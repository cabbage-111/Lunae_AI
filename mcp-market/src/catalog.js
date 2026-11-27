import { localNameOf, serverKey } from './manifest.js';
import { validateManifest } from './validate.js';

const URL_TEMPLATE = /\{([a-z0-9_-]+)\}/gi;
const ENV_REFERENCE = /^\$\{([A-Za-z0-9_]+)\}$/;

// Keep in step with McpType / Status in server/app/model/mcp/mcp.py.
export const TYPE_LOCAL = 1;
export const TYPE_REMOTE = 2;
export const STATUS_ONLINE = 1;

// The ten columns `seed_mcp_market.py` inserts. Duplicated here on purpose so a
// test can prove the record never grows a field the table cannot hold; the
// consuming side asserts the same subset at runtime.
export const ROW_COLUMNS = [
  'category',
  'name',
  'key',
  'description',
  'home_page',
  'type',
  'status',
  'sort',
  'server_name',
  'install_command',
];

// Carried for traceability. The seed script keeps them out of the table but
// must know them by name, or its whitelist would drop them silently.
export const ROW_PROVENANCE = ['manifest', 'version', 'pending_env', 'source'];

// The MCP client rejects the hyphenated spelling; a stored row must be runnable
// as-is, so the transport is mapped here rather than fixed up at read time.
const TRANSPORT = {
  http: 'streamable_http',
  stdio: 'stdio',
};

function declaredCategory(raw) {
  if (typeof raw.category === 'string' && raw.category.trim()) {
    return raw.category.trim();
  }
  const list = Array.isArray(raw.categories) ? raw.categories : [];
  const first = list.find((item) => typeof item === 'string' && item.trim());
  return first ? first.trim() : null;
}

function declaredTitle(raw, name) {
  if (typeof raw.title === 'string' && raw.title.trim())
    return raw.title.trim();
  return localNameOf(name);
}

function resolveUrl(url, variables) {
  const missing = [];
  const resolved = url.replace(URL_TEMPLATE, (token, name) => {
    const declared = variables.find((entry) => entry.name === name);
    if (declared && declared.default !== undefined) {
      return encodeURIComponent(declared.default);
    }
    missing.push(name);
    return token;
  });
  return { url: resolved, missing };
}

/**
 * A `${VAR}` reference describes a value the host must ask for. A catalogue row
 * cannot ask, so the key is kept with an empty value and reported: an empty
 * value is visible in the install form, a literal "${VAR}" would be sent to
 * the server as if it were the secret.
 */
function flattenValues(source, pending) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    const reference =
      typeof value === 'string' ? value.match(ENV_REFERENCE) : null;
    if (reference) {
      out[key] = '';
      pending.push(key);
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

function installCommandOf(manifest) {
  const pending = [];
  const type = TRANSPORT[manifest.run.type] ?? 'stdio';

  if (manifest.run.type === 'http') {
    const { url, missing } = resolveUrl(manifest.run.url, manifest.variables);
    if (missing.length > 0) {
      return {
        unrunnable: `URL needs ${missing.join(', ')}; the row cannot be installed without it`,
      };
    }
    const headers = flattenValues(
      { ...manifest.run.headers, ...manifest.auth.headers },
      pending
    );
    const command = { type, url };
    if (Object.keys(headers).length > 0) command.headers = headers;
    return { command, pending };
  }

  const command = { type: 'stdio', command: manifest.run.command };
  if (manifest.run.args.length > 0) command.args = [...manifest.run.args];
  const env = flattenValues(manifest.run.env, pending);
  if (Object.keys(env).length > 0) command.env = env;
  return { command, pending };
}

function uniqueKey(manifest, used) {
  const base = serverKey(manifest.name) || 'server';
  if (!used.has(base)) return base;

  const namespace = manifest.publisher.namespace
    .split('.')
    .join('-')
    .replace(/[^a-z0-9-]/g, '');
  const prefixed = `${namespace}-${base}`;
  if (!used.has(prefixed)) return prefixed;

  let counter = 2;
  while (used.has(`${prefixed}-${counter}`)) counter += 1;
  return `${prefixed}-${counter}`;
}

/**
 * Turn one manifest into the row shape `server/scripts/seed_mcp_market.py`
 * inserts. Returns `{ record }` or `{ rejected }` — never throws, because one
 * bad manifest must not stop the rest of the catalogue from being written.
 */
export function catalogRecord(manifest, { sort = 0, used = new Set() } = {}) {
  const issues = validateManifest(manifest);
  const errors = issues.filter((entry) => entry.severity === 'error');
  if (errors.length > 0) {
    return {
      rejected: {
        name: manifest.name || '(no name)',
        reason: 'INVALID',
        detail: errors.map((entry) => entry.code).join(', '),
      },
    };
  }

  const built = installCommandOf(manifest);
  if (built.unrunnable) {
    return {
      rejected: {
        name: manifest.name,
        reason: 'UNRUNNABLE',
        detail: built.unrunnable,
      },
    };
  }

  const key = uniqueKey(manifest, used);
  used.add(key);

  return {
    record: {
      // null means "the host classifies it"; the seed script owns the keyword
      // table, so the rule set stays in exactly one place.
      category: declaredCategory(manifest.raw),
      name: declaredTitle(manifest.raw, manifest.name).slice(0, 200),
      key: key.slice(0, 128),
      description: manifest.description,
      home_page: manifest.publisher.url,
      type: manifest.run.type === 'http' ? TYPE_REMOTE : TYPE_LOCAL,
      status: STATUS_ONLINE,
      sort,
      server_name: key.slice(0, 128),
      install_command: built.command,
      // Traceability: which manifest produced this row. The seed script drops
      // these three fields before inserting.
      manifest: manifest.name,
      version: manifest.version,
      pending_env: built.pending || [],
    },
  };
}

export function buildCatalog(entries, { origin = [] } = {}) {
  const used = new Set();
  const records = [];
  const rejected = [];
  const warnings = [];

  entries.forEach((entry) => {
    const result = catalogRecord(entry.manifest, { used });
    if (result.rejected) {
      rejected.push({ ...result.rejected, source: entry.source });
      return;
    }
    // Numbered by position in the catalogue, not in the source, so a rejected
    // manifest does not leave a gap in the market ordering.
    const record = {
      ...result.record,
      sort: (records.length + 1) * 10,
      source: entry.source,
    };
    records.push(record);
    if (record.pending_env.length > 0) {
      warnings.push({
        code: 'ENV_REQUIRED',
        severity: 'warn',
        source: entry.source,
        message: `${entry.manifest.name} needs ${record.pending_env.join(', ')} before it can connect`,
      });
    }
  });

  return { records, rejected, warnings, origin };
}

export function catalogEnvelope(catalog) {
  return {
    generator: 'mcp-market',
    schemaVersion: 1,
    sources: catalog.origin,
    count: catalog.records.length,
    records: catalog.records,
    rejected: catalog.rejected,
    warnings: catalog.warnings,
  };
}
