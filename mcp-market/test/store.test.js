import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readConfig, writeConfig } from '../src/store.js';

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-market-store-'));
  return {
    dir,
    file: path.join(dir, '.vscode', 'mcp.json'),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const weather = {
  inputs: [
    {
      id: 'weather_api_key',
      type: 'promptString',
      description: 'key',
      password: true,
    },
  ],
  servers: { weather: { type: 'http', url: 'https://mcp.example.io/mcp' } },
};

test('writeConfig creates the directory and the config file', async () => {
  const space = await workspace();
  try {
    const result = await writeConfig(space.file, weather, { target: 'vscode' });
    assert.equal(result.action, 'added');
    const written = JSON.parse(await readFile(space.file, 'utf8'));
    assert.equal(written.servers.weather.url, 'https://mcp.example.io/mcp');
    assert.equal(written.inputs.length, 1);
  } finally {
    await space.cleanup();
  }
});

test('writeConfig merges inputs by id and keeps other servers', async () => {
  const space = await workspace();
  try {
    await writeConfig(space.file, weather, { target: 'vscode' });
    await writeConfig(
      space.file,
      {
        inputs: [
          {
            id: 'weather_api_key',
            type: 'promptString',
            description: 'other',
            password: true,
          },
        ],
        servers: { notes: { type: 'http', url: 'https://mcp.acme.com/mcp' } },
      },
      { target: 'vscode' }
    );
    const written = JSON.parse(await readFile(space.file, 'utf8'));
    assert.deepEqual(Object.keys(written.servers), ['weather', 'notes']);
    assert.equal(written.inputs.length, 1);
    assert.equal(written.inputs[0].description, 'key');
  } finally {
    await space.cleanup();
  }
});

test('a duplicate install is refused without --force', async () => {
  const space = await workspace();
  try {
    await writeConfig(space.file, weather, { target: 'vscode' });
    await assert.rejects(
      () => writeConfig(space.file, weather, { target: 'vscode' }),
      (error) => error.code === 'ALREADY_INSTALLED'
    );
  } finally {
    await space.cleanup();
  }
});

test('--force replaces an existing entry', async () => {
  const space = await workspace();
  try {
    await writeConfig(space.file, weather, { target: 'vscode' });
    const result = await writeConfig(
      space.file,
      {
        servers: {
          weather: { type: 'http', url: 'https://new.example.io/mcp' },
        },
      },
      { target: 'vscode', force: true }
    );
    assert.equal(result.action, 'replaced');
    const written = JSON.parse(await readFile(space.file, 'utf8'));
    assert.equal(written.servers.weather.url, 'https://new.example.io/mcp');
  } finally {
    await space.cleanup();
  }
});

test('readConfig reports a corrupt file instead of ignoring it', async () => {
  const space = await workspace();
  try {
    await writeConfig(space.file, weather, { target: 'vscode' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(space.file, '{ not json', 'utf8');
    await assert.rejects(
      () => readConfig(space.file),
      (error) => error.code === 'BAD_CONFIG'
    );
  } finally {
    await space.cleanup();
  }
});

test('writeConfig needs exactly one server per call', async () => {
  const space = await workspace();
  try {
    await assert.rejects(
      () => writeConfig(space.file, { servers: {} }, { target: 'vscode' }),
      (error) => error.code === 'BAD_CONFIG'
    );
  } finally {
    await space.cleanup();
  }
});
