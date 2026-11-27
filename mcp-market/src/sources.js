import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isPinnedVersion, normalizeManifest } from './manifest.js';

/**
 * Build the argv each registry actually understands. `npx -y pkg@1.2.3` and
 * `uvx pkg==1.2.3` are different languages: `-y` means nothing to uvx, and
 * `pkg@1.2.3` is not a pip specifier. Getting this wrong writes rows that look
 * installed and then fail at connect time.
 */
export function launchFor(registry, identifier, version) {
  const pinned = isPinnedVersion(version);
  if (registry === 'oci' || registry === 'docker') {
    return {
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        pinned ? `${identifier}:${version}` : identifier,
      ],
    };
  }
  if (registry === 'pypi') {
    return {
      command: 'uvx',
      args: [pinned ? `${identifier}==${version}` : identifier],
    };
  }
  return {
    command: 'npx',
    args: ['-y', pinned ? `${identifier}@${version}` : identifier],
  };
}

function withCursor(baseUrl, cursor) {
  const url = new URL(baseUrl);
  url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function fromRegistryServer(entry) {
  const server =
    entry && typeof entry === 'object' && entry.server ? entry.server : entry;
  if (!server || typeof server !== 'object') {
    throw new TypeError('registry entry is not an object');
  }

  const name = String(server.name ?? '');
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const first = packages[0];

  const manifest = {
    name,
    version: String(server.version ?? first?.version ?? ''),
    description: String(server.description ?? ''),
    publisher: { namespace: name.split('/')[0] },
    packages: packages.map((item) => ({
      registry: String(item.registryType ?? item.registry ?? 'npm'),
      identifier: String(item.identifier ?? item.name ?? ''),
      version: String(item.version ?? ''),
    })),
  };

  if (remotes.length > 0) {
    manifest.run = { type: 'http', url: String(remotes[0].url ?? '') };
  } else if (first) {
    const registry = String(first.registryType ?? 'npm');
    const identifier = String(first.identifier ?? '');
    const launch = launchFor(registry, identifier, String(first.version ?? ''));
    manifest.run = {
      type: 'stdio',
      command: launch.command,
      args: launch.args,
    };
  } else {
    manifest.run = { type: 'stdio' };
  }

  return manifest;
}

export async function loadSources(file) {
  const text = await readFile(file, 'utf8');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(list)) {
    throw new TypeError(`${file}: expected an array of sources`);
  }
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`${file}: source #${index + 1} is not an object`);
    }
    return {
      id: String(entry.id ?? `${entry.type}-${index + 1}`),
      type: String(entry.type ?? ''),
      url: entry.url ? String(entry.url) : '',
      path: entry.path ? String(entry.path) : '',
    };
  });
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value || '0')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const leftPre = String(left).includes('-');
  const rightPre = String(right).includes('-');
  if (leftPre !== rightPre) return leftPre ? -1 : 1;
  return String(left).localeCompare(String(right));
}

export function dedupeByName(entries) {
  const best = new Map();
  let collapsed = 0;
  for (const entry of entries) {
    const name = entry.manifest.name;
    const current = best.get(name);
    if (!current) {
      best.set(name, entry);
      continue;
    }
    collapsed += 1;
    if (compareVersions(entry.manifest.version, current.manifest.version) > 0) {
      best.set(name, entry);
    }
  }
  return { servers: [...best.values()], collapsed };
}

export async function fetchRegistryPages(
  url,
  { fetchImpl = fetch, maxPages = 20 } = {}
) {
  const items = [];
  let next = url;
  let pages = 0;
  while (next && pages < maxPages) {
    const response = await fetchImpl(next);
    if (!response.ok) {
      throw new Error(`registry responded ${response.status} for ${next}`);
    }
    const body = await response.json();
    const batch = Array.isArray(body.servers) ? body.servers : [];
    items.push(...batch);
    pages += 1;
    const cursor = body?.metadata?.nextCursor ?? body?.nextCursor;
    next = cursor ? withCursor(url, cursor) : null;
  }
  return { items, pages, truncated: Boolean(next) };
}

function indexEntries(parsed, label) {
  const entries = Array.isArray(parsed) ? parsed : parsed.servers;
  if (!Array.isArray(entries)) {
    throw new TypeError(`${label}: expected a "servers" array`);
  }
  return entries;
}

async function readMarketplace(file, baseDir) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  const parsed = JSON.parse(await readFile(absolute, 'utf8'));
  const manifests = [];
  for (const entry of indexEntries(parsed, absolute)) {
    if (typeof entry === 'string') {
      const target = path.isAbsolute(entry)
        ? entry
        : path.resolve(path.dirname(absolute), entry);
      manifests.push(
        normalizeManifest(JSON.parse(await readFile(target, 'utf8')))
      );
    } else {
      manifests.push(normalizeManifest(entry));
    }
  }
  return manifests;
}

async function readMarketplaceUrl(indexUrl, fetchImpl) {
  const response = await fetchImpl(indexUrl);
  if (!response.ok) {
    throw new Error(`marketplace responded ${response.status} for ${indexUrl}`);
  }
  const manifests = [];
  for (const entry of indexEntries(await response.json(), indexUrl)) {
    if (typeof entry === 'string') {
      const target = new URL(entry, indexUrl).toString();
      const manifestResponse = await fetchImpl(target);
      if (!manifestResponse.ok) {
        throw new Error(
          `marketplace entry responded ${manifestResponse.status} for ${target}`
        );
      }
      manifests.push(normalizeManifest(await manifestResponse.json()));
    } else {
      manifests.push(normalizeManifest(entry));
    }
  }
  return manifests;
}

export async function collectServers(
  sources,
  {
    fetchImpl = fetch,
    maxPages = 20,
    baseDir = process.cwd(),
    allVersions = false,
  } = {}
) {
  const servers = [];
  const warnings = [];

  for (const source of sources) {
    try {
      if (source.type === 'registry') {
        const { items, pages, truncated } = await fetchRegistryPages(
          source.url,
          {
            fetchImpl,
            maxPages,
          }
        );
        const adapted = items.map((item) => ({
          manifest: normalizeManifest(fromRegistryServer(item)),
          source: source.id,
        }));
        const { servers: unique, collapsed } = allVersions
          ? { servers: adapted, collapsed: 0 }
          : dedupeByName(adapted);
        servers.push(...unique);
        warnings.push({
          code: 'SOURCE_PAGES',
          severity: 'info',
          source: source.id,
          message: `${items.length} row(s) over ${pages} page(s), ${unique.length} server(s)`,
        });
        if (collapsed > 0) {
          warnings.push({
            code: 'SOURCE_DUPLICATES',
            severity: 'info',
            source: source.id,
            message: `${collapsed} version row(s) collapsed to the newest build`,
          });
        }
        if (truncated) {
          warnings.push({
            code: 'SOURCE_TRUNCATED',
            severity: 'warn',
            source: source.id,
            message: `stopped at ${pages} page(s) with more remaining; raise --max-pages`,
          });
        }
      } else if (source.type === 'marketplace') {
        const manifests = source.url
          ? await readMarketplaceUrl(source.url, fetchImpl)
          : await readMarketplace(source.path, baseDir);
        for (const manifest of manifests) {
          servers.push({ manifest, source: source.id });
        }
      } else {
        warnings.push({
          code: 'UNKNOWN_SOURCE',
          severity: 'warn',
          source: source.id,
          message: `unsupported source type "${source.type}"`,
        });
      }
    } catch (error) {
      warnings.push({
        code: 'SOURCE_UNAVAILABLE',
        severity: 'warn',
        source: source.id,
        message: error.message,
      });
    }
  }

  servers.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name)
  );
  return { servers, warnings };
}

export function findServer(servers, name) {
  return servers.find((entry) => entry.manifest.name === name) ?? null;
}
