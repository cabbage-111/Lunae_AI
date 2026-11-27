import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inputIdFor,
  isPinnedVersion,
  isReverseDns,
  namespaceOf,
  normalizeManifest,
  serverKey,
} from '../src/manifest.js';

test('isReverseDns accepts dotted namespaces and rejects bare names', () => {
  assert.equal(isReverseDns('io.example/weather'), true);
  assert.equal(isReverseDns('com.acme/notes-v2'), true);
  assert.equal(isReverseDns('weather'), false);
  assert.equal(isReverseDns('Weather/Thing'), false);
  assert.equal(isReverseDns('example/thing'), false);
});

test('isPinnedVersion only accepts an exact semver', () => {
  assert.equal(isPinnedVersion('1.2.3'), true);
  assert.equal(isPinnedVersion('1.2.3-rc.1'), true);
  assert.equal(isPinnedVersion('^1.2.3'), false);
  assert.equal(isPinnedVersion('latest'), false);
});

test('namespaceOf and serverKey split the identifier at the slash', () => {
  assert.equal(namespaceOf('io.example/weather'), 'io.example');
  assert.equal(serverKey('io.example/weather'), 'weather');
  assert.equal(serverKey('io.example/Weather_Station'), 'weather_station');
});

test('inputIdFor produces a stable client input id', () => {
  assert.equal(inputIdFor('WEATHER_API_KEY'), 'weather_api_key');
  assert.equal(inputIdFor('Tenant Slug'), 'tenant_slug');
});

test('normalizeManifest fills defaults for an http manifest', () => {
  const manifest = normalizeManifest({
    name: 'io.example/weather',
    run: { url: 'https://mcp.example.io/mcp' },
  });
  assert.equal(manifest.run.type, 'http');
  assert.deepEqual(manifest.packages, []);
  assert.deepEqual(manifest.variables, []);
  assert.equal(manifest.publisher.verifiedBy, '');
});

test('normalizeManifest rejects anything but an object', () => {
  assert.throws(() => normalizeManifest([]), TypeError);
  assert.throws(() => normalizeManifest(null), TypeError);
});
