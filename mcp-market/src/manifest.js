import { readFile } from 'node:fs/promises';

export const MANIFEST_FILE = 'mcp-manifest.json';

const REVERSE_DNS =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\/[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isReverseDns(name) {
  return typeof name === 'string' && REVERSE_DNS.test(name);
}

export function isPinnedVersion(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

export function namespaceOf(name) {
  return typeof name === 'string' ? name.split('/')[0] : '';
}

export function localNameOf(name) {
  const index = typeof name === 'string' ? name.indexOf('/') : -1;
  return index === -1 ? String(name ?? '') : name.slice(index + 1);
}

export function serverKey(name) {
  return localNameOf(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function inputIdFor(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asObject(value, fallback) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fallback;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('manifest must be a JSON object');
  }

  const run = asObject(raw.run, {});
  const publisher = asObject(raw.publisher, {});
  const auth = asObject(raw.auth, {});
  const permissions = asObject(raw.permissions, {});

  const args = Array.isArray(run.args)
    ? run.args.map((arg) => String(arg))
    : [];
  const type = asString(run.type) || (run.url ? 'http' : 'stdio');

  return {
    raw,
    name: asString(raw.name),
    version: asString(raw.version),
    description: asString(raw.description),
    publisher: {
      namespace: asString(publisher.namespace),
      displayName: asString(publisher.displayName),
      url: asString(publisher.url),
      verifiedBy: asString(publisher.verifiedBy),
      domains: Array.isArray(publisher.domains)
        ? publisher.domains.map((domain) => String(domain))
        : [],
    },
    run: {
      type,
      command: asString(run.command),
      args,
      url: asString(run.url),
      env: asObject(run.env, {}),
      headers: asObject(run.headers, {}),
    },
    auth: {
      type: asString(auth.type),
      header: asString(auth.header),
      value: asString(auth.value),
      headers: asObject(auth.headers, {}),
    },
    packages: Array.isArray(raw.packages)
      ? raw.packages
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            registry: asString(item.registry),
            identifier: asString(item.identifier),
            version: asString(item.version),
          }))
      : [],
    permissions,
    variables: Array.isArray(raw.variables)
      ? raw.variables
          .filter((item) => item && typeof item === 'object' && item.name)
          .map((item) => ({
            name: asString(item.name),
            description: asString(item.description),
            default:
              item.default === undefined ? undefined : String(item.default),
            secret: item.secret === true,
          }))
      : [],
  };
}

export async function loadManifestFile(path) {
  const text = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${path} is not valid JSON: ${error.message}`);
  }
  return normalizeManifest(parsed);
}
