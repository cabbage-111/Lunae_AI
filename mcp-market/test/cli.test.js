import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  runAdd,
  runCatalog,
  runIndex,
  runInit,
  runList,
  runVerify,
} from '../src/commands.js';
import { ROOT } from '../src/paths.js';

const run = promisify(execFile);

const WEATHER = path.join(ROOT, 'examples/servers/weather.json');
const NOTES = path.join(ROOT, 'examples/servers/notes.json');
const DRIFT = path.join(ROOT, 'examples/servers/drift.json');
const EXAMPLES = path.join(ROOT, 'examples/marketplace.json');

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-market-cli-'));
  const sources = path.join(dir, 'sources.json');
  await writeFile(
    sources,
    JSON.stringify([{ id: 'examples', type: 'marketplace', path: EXAMPLES }]),
    'utf8'
  );
  return {
    dir,
    sources,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('init writes a manifest that passes verify --strict', async () => {
  const space = await scratch();
  try {
    const created = await runInit({ dir: space.dir });
    assert.equal(created.code, 0);
    const verified = await runVerify({ files: [created.file], strict: true });
    assert.equal(verified.code, 0);
    assert.match(verified.text, /result: OK/);
  } finally {
    await space.cleanup();
  }
});

test('init refuses to overwrite without --force', async () => {
  const space = await scratch();
  try {
    await runInit({ dir: space.dir });
    const second = await runInit({ dir: space.dir });
    assert.equal(second.code, 1);
    assert.match(second.text, /--force/);
  } finally {
    await space.cleanup();
  }
});

test('verify reports every finding of the drift sample', async () => {
  const result = await runVerify({ files: [DRIFT] });
  assert.equal(result.code, 0);
  assert.equal(result.warnings, 4);
  for (const code of [
    'UNPINNED_PACKAGE',
    'ENTRY_PACKAGE_MISMATCH',
    'NO_PERMISSIONS',
    'SELF_ASSERTED',
  ]) {
    assert.match(result.text, new RegExp(`warn  drift\\.json ${code}:`));
  }
});

test('verify --strict fails on warnings', async () => {
  const result = await runVerify({ files: [DRIFT], strict: true });
  assert.equal(result.code, 1);
  assert.match(result.text, /strict treats warnings as failures/);
});

test('verify --json is machine readable', async () => {
  const result = await runVerify({ files: [DRIFT], json: true });
  const payload = JSON.parse(result.text);
  assert.equal(payload.warnings, 4);
  assert.equal(payload.errors, 0);
});

test('add renders a vscode config with a declared input', async () => {
  const space = await scratch();
  try {
    const result = await runAdd('io.example/weather', {
      target: 'vscode',
      sourcesFile: space.sources,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.issues, []);
    assert.equal(
      result.config.servers.weather.url,
      'https://mcp.example.io/mcp'
    );
    assert.equal(result.config.inputs[0].id, 'weather_api_key');
    assert.match(result.text, /permissions: network=mcp\.example\.io/);
  } finally {
    await space.cleanup();
  }
});

test('add prints the permissions state a host can refuse on', async () => {
  const result = await runAdd(DRIFT, { target: 'vscode' });
  assert.equal(result.code, 0);
  assert.match(result.text, /permissions: UNDECLARED/);
  assert.match(result.text, /NO_PERMISSIONS/);
});

test('add falls back to an input prompt for a portable target', async () => {
  const result = await runAdd(NOTES, { target: 'portable' });
  assert.equal(result.code, 1);
  assert.match(result.text, /MISSING_VARIABLE/);
});

test('add fills a portable URL from --var', async () => {
  const result = await runAdd(NOTES, {
    target: 'portable',
    vars: { tenant: 'acme' },
  });
  assert.equal(result.code, 0);
  assert.equal(
    result.config.mcpServers.notes.url,
    'https://mcp.acme.com/acme/mcp'
  );
});

test('add emits a deep link that carries the endpoint', async () => {
  const result = await runAdd('io.example/weather', {
    target: 'link',
    sourcesFile: (await scratch()).sources,
  });
  assert.equal(result.code, 0);
  const payload = JSON.parse(
    decodeURIComponent(result.link.slice('vscode:mcp/install?'.length))
  );
  assert.equal(payload.url, 'https://mcp.example.io/mcp');
});

test('add refuses a manifest that cannot describe a process', async () => {
  const space = await scratch();
  try {
    const broken = path.join(space.dir, 'broken.json');
    await writeFile(
      broken,
      JSON.stringify({
        name: 'io.example/broken',
        version: '1.0.0',
        publisher: { namespace: 'io.example', verifiedBy: 'dns-txt' },
        run: { type: 'stdio' },
        permissions: { network: ['example.io'] },
      }),
      'utf8'
    );
    const result = await runAdd(broken, { target: 'vscode' });
    assert.equal(result.code, 1);
    assert.match(result.text, /NO_RUN_INSTRUCTION/);
    assert.match(result.text, /refusing to install/);
  } finally {
    await space.cleanup();
  }
});

test('add --write installs into the target config path', async () => {
  const space = await scratch();
  try {
    const destination = path.join(space.dir, '.vscode', 'mcp.json');
    const result = await runAdd(WEATHER, {
      target: 'vscode',
      write: true,
      config: destination,
    });
    assert.equal(result.code, 0);
    const written = JSON.parse(await readFile(destination, 'utf8'));
    assert.ok(written.servers.weather);
    assert.equal(written.servers.weather.type, 'http');
  } finally {
    await space.cleanup();
  }
});

test('add rejects an unknown target with a usage error', async () => {
  const result = await runAdd(WEATHER, { target: 'jetbrains' });
  assert.equal(result.code, 2);
  assert.match(result.text, /UNKNOWN_TARGET/);
});

test('list reads the configured marketplace', async () => {
  const space = await scratch();
  try {
    const result = await runList({ sourcesFile: space.sources });
    assert.equal(result.code, 0);
    assert.match(result.text, /com\.acme\/notes/);
    assert.match(result.text, /io\.example\/weather/);
    assert.match(result.text, /2 server\(s\) from 1 source\(s\)/);
  } finally {
    await space.cleanup();
  }
});

test('the cli exits 1 when --strict finds a warning', async () => {
  try {
    await run(
      process.execPath,
      [path.join(ROOT, 'src/cli.js'), 'verify', DRIFT, '--strict'],
      {
        cwd: ROOT,
      }
    );
    assert.fail('expected a non-zero exit');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /result: FAIL/);
  }
});

test('the cli exits 0 without --strict', async () => {
  const { stdout } = await run(
    process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'verify', DRIFT],
    { cwd: ROOT }
  );
  assert.match(stdout, /result: OK/);
});

async function manifestsDir(space) {
  const dir = path.join(space.dir, 'servers');
  await mkdir(dir, { recursive: true });
  return dir;
}

test('index builds a marketplace from a directory of manifests', async () => {
  const space = await scratch();
  try {
    const dir = await manifestsDir(space);
    await copyFile(WEATHER, path.join(dir, 'weather.json'));
    await copyFile(NOTES, path.join(dir, 'notes.json'));

    const result = await runIndex({ dir });
    assert.equal(result.code, 0);
    const index = JSON.parse(
      await readFile(path.join(dir, 'marketplace.json'), 'utf8')
    );
    assert.deepEqual(index.servers, ['./notes.json', './weather.json']);
    assert.match(result.text, /wrote .*marketplace\.json \(2 server\(s\)\)/);
  } finally {
    await space.cleanup();
  }
});

test('index refuses to publish an index containing a broken manifest', async () => {
  const space = await scratch();
  try {
    const dir = await manifestsDir(space);
    await copyFile(WEATHER, path.join(dir, 'weather.json'));
    await writeFile(
      path.join(dir, 'broken.json'),
      JSON.stringify({
        name: 'io.example/broken',
        version: '1.0.0',
        publisher: { namespace: 'io.example', verifiedBy: 'dns-txt' },
        run: { type: 'stdio' },
        permissions: { network: ['example.io'] },
      }),
      'utf8'
    );

    const result = await runIndex({ dir });
    assert.equal(result.code, 1);
    assert.match(result.text, /NO_RUN_INSTRUCTION/);
    await assert.rejects(() => readFile(path.join(dir, 'marketplace.json')));
  } finally {
    await space.cleanup();
  }
});

test('index --skip-invalid publishes the valid subset', async () => {
  const space = await scratch();
  try {
    const dir = await manifestsDir(space);
    await copyFile(WEATHER, path.join(dir, 'weather.json'));
    await writeFile(
      path.join(dir, 'broken.json'),
      JSON.stringify({ name: 'io.example/broken', run: {} }),
      'utf8'
    );

    const result = await runIndex({ dir, skipInvalid: true });
    assert.equal(result.code, 0);
    const index = JSON.parse(
      await readFile(path.join(dir, 'marketplace.json'), 'utf8')
    );
    assert.deepEqual(index.servers, ['./weather.json']);
    assert.match(result.text, /1 skipped/);
  } finally {
    await space.cleanup();
  }
});

test('index writes entry paths relative to the index location', async () => {
  const space = await scratch();
  try {
    const dir = await manifestsDir(space);
    await copyFile(WEATHER, path.join(dir, 'weather.json'));
    const out = path.join(space.dir, 'public', 'marketplace.json');

    const result = await runIndex({ dir, out });
    assert.equal(result.code, 0);
    const index = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(index.servers, ['../servers/weather.json']);
  } finally {
    await space.cleanup();
  }
});

test('catalog --json stays parseable even when it refuses to write', async () => {
  const space = await scratch();
  try {
    const result = await runCatalog({ sourcesFile: space.sources, json: true });
    const envelope = JSON.parse(result.text);

    assert.equal(result.code, 1);
    assert.equal(envelope.records.length, 1);
    assert.equal(envelope.rejected[0].reason, 'UNRUNNABLE');
  } finally {
    await space.cleanup();
  }
});

test('catalog --skip-invalid writes the rows that can run', async () => {
  const space = await scratch();
  try {
    const result = await runCatalog({
      sourcesFile: space.sources,
      json: true,
      skipInvalid: true,
    });
    const envelope = JSON.parse(result.text);

    assert.equal(result.code, 0);
    assert.deepEqual(
      envelope.records.map((record) => record.key),
      ['weather']
    );
    assert.equal(envelope.records[0].install_command.type, 'streamable_http');
  } finally {
    await space.cleanup();
  }
});

test('catalog --out writes the envelope the seed script reads', async () => {
  const space = await scratch();
  try {
    const out = path.join(space.dir, 'rows.json');
    const result = await runCatalog({
      sourcesFile: space.sources,
      out,
      skipInvalid: true,
    });

    assert.equal(result.code, 0);
    assert.match(result.text, /wrote .*rows\.json/);
    const envelope = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(envelope.generator, 'mcp-market');
    assert.equal(envelope.count, 1);
    assert.equal(envelope.records[0].manifest, 'io.example/weather');
  } finally {
    await space.cleanup();
  }
});
