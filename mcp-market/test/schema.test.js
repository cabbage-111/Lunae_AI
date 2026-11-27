import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ROOT } from '../src/paths.js';
import { goodManifest } from './helpers.js';

const schema = JSON.parse(
  await readFile(path.join(ROOT, 'schema/mcp-manifest.schema.json'), 'utf8')
);

test('the published schema declares the four non-negotiable fields', () => {
  assert.deepEqual([...schema.required].sort(), [
    'name',
    'publisher',
    'run',
    'version',
  ]);
});

test('every field the code reads appears in the published schema', () => {
  const manifest = goodManifest();
  for (const key of Object.keys(manifest)) {
    assert.ok(schema.properties[key], `schema is missing "${key}"`);
  }
});

test('the market-listing fields read by catalog are declared too', () => {
  for (const key of ['title', 'category', 'categories']) {
    assert.ok(schema.properties[key], `schema is missing "${key}"`);
  }
});

test('the schema name pattern matches the loader rule', () => {
  const pattern = new RegExp(schema.properties.name.pattern);
  assert.ok(pattern.test('io.example/weather'));
  assert.ok(!pattern.test('weather'));
  assert.ok(!pattern.test('Weather/Thing'));
});

test('the schema version pattern rejects ranges', () => {
  const pattern = new RegExp(schema.properties.version.pattern);
  assert.ok(pattern.test('1.2.3'));
  assert.ok(pattern.test('1.2.3-rc.1'));
  assert.ok(!pattern.test('^1.2.3'));
});

test('the schema pins the transports the loader can run', () => {
  assert.deepEqual(schema.properties.run.properties.type.enum, [
    'stdio',
    'http',
  ]);
});
