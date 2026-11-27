import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EmitError,
  buildLink,
  buildPortable,
  buildVscode,
  emitConfig,
  emptyConfigFor,
} from '../src/emit.js';
import { normalizeManifest } from '../src/manifest.js';
import { goodManifest, remoteManifest } from './helpers.js';

function vscode(raw, values) {
  return buildVscode(normalizeManifest(raw), { values });
}

function portable(raw, values) {
  return buildPortable(normalizeManifest(raw), { values });
}

test('vscode: a secret header becomes a declared input', () => {
  const config = vscode(remoteManifest());
  assert.deepEqual(config.inputs, [
    {
      id: 'weather_api_key',
      type: 'promptString',
      description: 'Secret WEATHER_API_KEY for weather (x-api-key)',
      password: true,
    },
  ]);
  assert.equal(
    config.servers.weather.headers['x-api-key'],
    '${input:weather_api_key}'
  );
});

test('vscode: a secret env value becomes a declared input', () => {
  const config = vscode(
    goodManifest({
      run: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/weather-mcp@1.2.0'],
        env: { WEATHER_API_KEY: '${WEATHER_API_KEY}' },
      },
    })
  );
  assert.equal(
    config.servers.weather.env.WEATHER_API_KEY,
    '${input:weather_api_key}'
  );
  assert.equal(config.inputs.length, 1);
});

test('vscode: an unfilled URL variable stays an input, not a guess', () => {
  const config = vscode(
    remoteManifest({
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
      variables: [{ name: 'tenant', description: 'Your tenant slug' }],
    })
  );
  assert.equal(
    config.servers.weather.url,
    'https://mcp.example.io/${input:tenant}/mcp'
  );
  assert.deepEqual(config.inputs, [
    {
      id: 'tenant',
      type: 'promptString',
      description: 'Your tenant slug',
      password: false,
    },
  ]);
});

test('vscode: a supplied URL variable is encoded into the path', () => {
  const config = vscode(
    remoteManifest({
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
      variables: [{ name: 'tenant' }],
    }),
    { tenant: 'acme corp' }
  );
  assert.equal(
    config.servers.weather.url,
    'https://mcp.example.io/acme%20corp/mcp'
  );
});

test('portable: secrets are host environment references, never inlined', () => {
  const config = portable(remoteManifest());
  assert.equal(
    config.mcpServers.weather.headers['x-api-key'],
    '${env:WEATHER_API_KEY}'
  );
  assert.equal(config.inputs, undefined);
});

test('portable: a supplied variable fills the URL template', () => {
  const config = portable(
    {
      ...remoteManifest(),
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
      variables: [{ name: 'tenant' }],
    },
    { tenant: 'acme' }
  );
  assert.equal(
    config.mcpServers.weather.url,
    'https://mcp.example.io/acme/mcp'
  );
});

test('portable: a missing variable is an error, not a silent blank', () => {
  const manifest = normalizeManifest({
    ...remoteManifest(),
    run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
    variables: [{ name: 'tenant' }],
  });
  assert.throws(
    () => buildPortable(manifest),
    (error) => error instanceof EmitError && error.code === 'MISSING_VARIABLE'
  );
});

test('portable: a variable default removes the need to pass one', () => {
  const config = portable(
    {
      ...remoteManifest(),
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
      variables: [{ name: 'tenant', default: 'demo' }],
    },
    {}
  );
  assert.equal(
    config.mcpServers.weather.url,
    'https://mcp.example.io/demo/mcp'
  );
});

test('a templated header throws even when a value was supplied', () => {
  const manifest = normalizeManifest(
    remoteManifest({
      run: {
        type: 'http',
        url: 'https://mcp.example.io/mcp',
        headers: { 'x-tenant': '{tenant}' },
      },
      variables: [{ name: 'tenant' }],
    })
  );
  for (const build of [buildVscode, buildPortable, buildLink]) {
    assert.throws(
      () => build(manifest, { values: { tenant: 'acme' } }),
      (error) =>
        error instanceof EmitError && error.code === 'VARIABLE_IN_HEADER'
    );
  }
});

test('link: the payload round-trips through the deep link', () => {
  const link = buildLink(normalizeManifest(remoteManifest()), {
    values: {},
  });
  assert.ok(link.startsWith('vscode:mcp/install?'));
  const payload = JSON.parse(
    decodeURIComponent(link.slice('vscode:mcp/install?'.length))
  );
  assert.equal(payload.name, 'weather');
  assert.equal(payload.type, 'http');
  assert.equal(payload.url, 'https://mcp.example.io/mcp');
});

test('link: an unfilled variable is rejected instead of linked', () => {
  const manifest = normalizeManifest({
    ...remoteManifest(),
    run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
    variables: [{ name: 'tenant' }],
  });
  assert.throws(
    () => buildLink(manifest, { values: {} }),
    (error) => error.code === 'MISSING_VARIABLE'
  );
});

test('emitConfig rejects an unknown target', () => {
  assert.throws(
    () =>
      emitConfig(normalizeManifest(remoteManifest()), { target: 'jetbrains' }),
    (error) => error.code === 'UNKNOWN_TARGET'
  );
});

test('emptyConfigFor returns the shape each target merges into', () => {
  assert.deepEqual(emptyConfigFor('vscode'), { inputs: [], servers: {} });
  assert.deepEqual(emptyConfigFor('portable'), { mcpServers: {} });
});
