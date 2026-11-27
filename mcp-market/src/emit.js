import { inputIdFor, serverKey } from './manifest.js';

const HAS_TEMPLATE_TOKEN = /(?<!\$)\{[a-z0-9_-]+\}/i;
const TEMPLATE_TOKEN_ALL = /(?<!\$)\{([a-z0-9_-]+)\}/gi;
const ENV_REFERENCE = /^\$\{([A-Za-z0-9_]+)\}$/;

export class EmitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmitError';
    this.code = code;
  }
}

export const TARGETS = ['vscode', 'portable', 'link'];

export function assertTarget(target) {
  if (!TARGETS.includes(target)) {
    throw new EmitError(
      'UNKNOWN_TARGET',
      `unknown target "${target}"; expected one of ${TARGETS.join(', ')}`
    );
  }
}

function resolveValues(manifest, values) {
  const resolved = new Map();
  for (const declared of manifest.variables) {
    if (declared.default !== undefined)
      resolved.set(declared.name, declared.default);
  }
  for (const [name, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null && value !== '') {
      resolved.set(name, String(value));
    }
  }
  return resolved;
}

function variableByName(manifest, name) {
  return manifest.variables.find((entry) => entry.name === name);
}

function assertNoHeaderTemplate(headers) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value === 'string' && HAS_TEMPLATE_TOKEN.test(value)) {
      throw new EmitError(
        'VARIABLE_IN_HEADER',
        `header "${key}" contains a template variable; headers are never templated, prompt for the value instead`
      );
    }
  }
}

function makeInput(id, name, description, password) {
  return {
    id,
    type: 'promptString',
    description: description || `Value for ${name}`,
    password,
  };
}

function requestSecret(manifest, inputs, name, field) {
  const id = inputIdFor(name);
  if (!inputs.some((entry) => entry.id === id)) {
    inputs.push(
      makeInput(
        id,
        name,
        `Secret ${name} for ${serverKey(manifest.name)} (${field})`,
        true
      )
    );
  }
  return '${input:' + id + '}';
}

function mappedObject(manifest, inputs, source, { secretRef }) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    const reference =
      typeof value === 'string' ? value.match(ENV_REFERENCE) : null;
    if (!reference) {
      out[key] = String(value);
      continue;
    }
    const name = reference[1];
    out[key] =
      secretRef === 'input'
        ? requestSecret(manifest, inputs, name, key)
        : '${env:' + name + '}';
  }
  return out;
}

function httpUrl(manifest, inputs, resolved, { allowInputs }) {
  return manifest.run.url.replace(TEMPLATE_TOKEN_ALL, (token, name) => {
    if (resolved.has(name)) return encodeURIComponent(resolved.get(name));
    if (!allowInputs) {
      throw new EmitError(
        'MISSING_VARIABLE',
        `variable "${name}" has no value; pass --var ${name}=... or give it a default`
      );
    }
    const declared = variableByName(manifest, name);
    const id = inputIdFor(name);
    inputs.push(
      makeInput(
        id,
        name,
        declared?.description || `Value for ${name}`,
        declared?.secret === true
      )
    );
    return '${input:' + id + '}';
  });
}

function mergedHeaders(manifest) {
  return { ...manifest.run.headers, ...manifest.auth.headers };
}

export function buildVscode(manifest, { values } = {}) {
  const resolved = resolveValues(manifest, values);
  const inputs = [];
  const key = serverKey(manifest.name);
  const headers = mergedHeaders(manifest);
  assertNoHeaderTemplate(headers);

  const server = {};
  if (manifest.run.type === 'http') {
    server.type = 'http';
    server.url = httpUrl(manifest, inputs, resolved, { allowInputs: true });
    const rendered = mappedObject(manifest, inputs, headers, {
      secretRef: 'input',
    });
    if (Object.keys(rendered).length > 0) server.headers = rendered;
  } else {
    server.type = 'stdio';
    server.command = manifest.run.command;
    if (manifest.run.args.length > 0) server.args = [...manifest.run.args];
    const env = mappedObject(manifest, inputs, manifest.run.env, {
      secretRef: 'input',
    });
    if (Object.keys(env).length > 0) server.env = env;
  }

  const config = {};
  if (inputs.length > 0) config.inputs = inputs;
  config.servers = { [key]: server };
  return config;
}

export function buildPortable(manifest, { values } = {}) {
  const resolved = resolveValues(manifest, values);
  const key = serverKey(manifest.name);
  const headers = mergedHeaders(manifest);
  assertNoHeaderTemplate(headers);

  const server = {};
  if (manifest.run.type === 'http') {
    server.url = httpUrl(manifest, [], resolved, { allowInputs: false });
    const rendered = mappedObject(manifest, [], headers, { secretRef: 'env' });
    if (Object.keys(rendered).length > 0) server.headers = rendered;
  } else {
    server.command = manifest.run.command;
    if (manifest.run.args.length > 0) server.args = [...manifest.run.args];
    const env = mappedObject(manifest, [], manifest.run.env, {
      secretRef: 'env',
    });
    if (Object.keys(env).length > 0) server.env = env;
  }

  return { mcpServers: { [key]: server } };
}

export function buildLink(manifest, { values } = {}) {
  const resolved = resolveValues(manifest, values);
  const key = serverKey(manifest.name);
  const headers = mergedHeaders(manifest);
  assertNoHeaderTemplate(headers);

  const server = { name: key };
  if (manifest.run.type === 'http') {
    server.type = 'http';
    server.url = httpUrl(manifest, [], resolved, { allowInputs: false });
    const rendered = mappedObject(manifest, [], headers, { secretRef: 'env' });
    if (Object.keys(rendered).length > 0) server.headers = rendered;
  } else {
    server.command = manifest.run.command;
    if (manifest.run.args.length > 0) server.args = [...manifest.run.args];
  }

  return 'vscode:mcp/install?' + encodeURIComponent(JSON.stringify(server));
}

export function emitConfig(manifest, { target, values } = {}) {
  assertTarget(target);
  if (target === 'vscode') return buildVscode(manifest, { values });
  if (target === 'portable') return buildPortable(manifest, { values });
  return buildLink(manifest, { values });
}

export function emptyConfigFor(target) {
  assertTarget(target);
  return target === 'vscode' ? { inputs: [], servers: {} } : { mcpServers: {} };
}
