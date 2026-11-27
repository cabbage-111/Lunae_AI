import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROW_COLUMNS,
  ROW_PROVENANCE,
  buildCatalog,
  catalogRecord,
} from '../src/catalog.js';
import { normalizeManifest } from '../src/manifest.js';
import { byCode, codes, goodManifest, remoteManifest } from './helpers.js';

const asManifest = (raw) => normalizeManifest(raw);

test('a remote manifest becomes a remote row with a runnable transport', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));

  assert.equal(record.type, 2);
  assert.equal(record.status, 1);
  assert.equal(record.server_name, 'weather');
  assert.equal(record.key, 'weather');
  assert.deepEqual(record.install_command, {
    type: 'streamable_http',
    url: 'https://mcp.example.io/mcp',
    headers: { 'x-api-key': '' },
  });
});

test('a stdio manifest becomes a local row that keeps command and args', () => {
  const { record } = catalogRecord(asManifest(goodManifest()));

  assert.equal(record.type, 1);
  assert.deepEqual(record.install_command, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/weather-mcp@1.2.0'],
  });
});

test('an env reference is stored empty and reported, never as a literal', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));

  assert.equal(record.install_command.headers['x-api-key'], '');
  assert.deepEqual(record.pending_env, ['x-api-key']);
});

test('a URL variable without a default cannot become a row', () => {
  const manifest = asManifest(
    remoteManifest({
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
    })
  );
  const result = catalogRecord(manifest);

  assert.equal(result.record, undefined);
  assert.equal(result.rejected.reason, 'UNRUNNABLE');
  assert.match(result.rejected.detail, /tenant/);
});

test('a URL variable with a default is substituted and encoded', () => {
  const manifest = asManifest(
    remoteManifest({
      run: { type: 'http', url: 'https://mcp.example.io/{tenant}/mcp' },
      variables: [{ name: 'tenant', default: 'a b' }],
    })
  );
  const { record } = catalogRecord(manifest);

  assert.equal(record.install_command.url, 'https://mcp.example.io/a%20b/mcp');
});

test('an invalid manifest is rejected with the codes that blocked it', () => {
  const result = catalogRecord(asManifest(goodManifest({ name: 'weather' })));

  assert.equal(result.rejected.reason, 'INVALID');
  assert.match(result.rejected.detail, /BAD_NAME/);
});

test('two namespaces may publish the same local name', () => {
  const first = asManifest(goodManifest());
  const second = asManifest(
    goodManifest({
      name: 'com.other/weather',
      publisher: { namespace: 'com.other' },
    })
  );
  const used = new Set();
  const a = catalogRecord(first, { used }).record;
  const b = catalogRecord(second, { used }).record;

  assert.equal(a.key, 'weather');
  assert.equal(b.key, 'com-other-weather');
  assert.equal(b.server_name, 'com-other-weather');
});

test('catalog numbering has no gap where a manifest was rejected', () => {
  const entries = [
    {
      manifest: asManifest(
        goodManifest({ name: 'io.example/broken', run: {} })
      ),
      source: 'a',
    },
    { manifest: asManifest(remoteManifest()), source: 'a' },
  ];
  const catalog = buildCatalog(entries);

  assert.equal(catalog.rejected.length, 1);
  assert.deepEqual(
    catalog.records.map((record) => record.sort),
    [10]
  );
});

test('an undeclared category stays null so the host classifies it once', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));
  assert.equal(record.category, null);
});

test('a declared category or title wins over the derived default', () => {
  const { record } = catalogRecord(
    asManifest(
      remoteManifest({ title: 'Weather', categories: ['开发工具', '其他'] })
    )
  );

  assert.equal(record.name, 'Weather');
  assert.equal(record.category, '开发工具');
});

test('the default name is the local half of the reverse-DNS identifier', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));
  assert.equal(record.name, 'weather');
});

test('the row carries provenance for the seed log, minus the raw manifest', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));

  assert.equal(record.manifest, 'io.example/weather');
  assert.equal(record.version, '1.2.0');
  assert.equal(record.raw, undefined);
});

test('buildCatalog reports ENV_REQUIRED per record, not per field', () => {
  const catalog = buildCatalog([
    { manifest: asManifest(remoteManifest()), source: 's' },
  ]);

  assert.deepEqual(codes(catalog.warnings), ['ENV_REQUIRED']);
  assert.match(byCode(catalog.warnings, 'ENV_REQUIRED').message, /x-api-key/);
});

test('a record never carries a field the mcp table cannot hold', () => {
  const { record } = catalogRecord(asManifest(remoteManifest()));
  const allowed = new Set([...ROW_COLUMNS, ...ROW_PROVENANCE]);

  for (const key of Object.keys(record)) {
    assert.ok(allowed.has(key), `"${key}" is not a column and not provenance`);
  }
});

test('pending_env names exactly the values that were left blank', () => {
  const manifest = asManifest(
    goodManifest({
      run: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/weather-mcp@1.2.0'],
        env: { API_KEY: '${API_KEY}', REGION: 'eu-west-1' },
      },
    })
  );
  const { record } = catalogRecord(manifest);

  assert.deepEqual(Object.keys(record.install_command.env).sort(), [
    'API_KEY',
    'REGION',
  ]);
  assert.deepEqual(record.pending_env, ['API_KEY']);
  assert.equal(record.install_command.env.REGION, 'eu-west-1');
});
