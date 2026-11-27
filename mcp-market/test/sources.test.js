import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_SOURCES, ROOT } from '../src/paths.js';
import {
  collectServers,
  compareVersions,
  fetchRegistryPages,
  findServer,
  fromRegistryServer,
  loadSources,
} from '../src/sources.js';

const PAGES = [
  {
    servers: [
      {
        server: {
          name: 'io.github.acme/weather',
          version: '1.0.0',
          description: 'Weather tools',
          packages: [
            {
              registryType: 'npm',
              identifier: '@acme/weather',
              version: '1.0.0',
            },
          ],
        },
      },
    ],
    metadata: { nextCursor: 'page-2' },
  },
  {
    servers: [
      {
        server: {
          name: 'io.github.acme/notes',
          version: '2.0.0',
          description: 'Notes tools',
          remotes: [
            { type: 'streamable-http', url: 'https://mcp.acme.com/mcp' },
          ],
        },
      },
    ],
    metadata: {},
  },
];

async function startRegistry(pages) {
  const hits = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const cursor = url.searchParams.get('cursor');
    hits.push(cursor ?? 'first');
    const index = cursor === 'page-2' ? 1 : 0;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(pages[index]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v0/servers?limit=1`,
    hits,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('the shipped sources file names sources, not servers', async () => {
  const sources = await loadSources(DEFAULT_SOURCES);
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((source) => source.type),
    ['registry', 'marketplace']
  );
});

test('a marketplace source loads checked-in manifests', async () => {
  const { servers, warnings } = await collectServers(
    [
      {
        id: 'local-examples',
        type: 'marketplace',
        path: './examples/marketplace.json',
      },
    ],
    { baseDir: ROOT }
  );
  assert.deepEqual(
    servers.map((entry) => entry.manifest.name),
    ['com.acme/notes', 'io.example/weather']
  );
  assert.deepEqual(warnings, []);
});

test('a registry source follows nextCursor to the last page', async () => {
  const registry = await startRegistry(PAGES);
  try {
    const { items, pages } = await fetchRegistryPages(registry.url);
    assert.equal(items.length, 2);
    assert.equal(pages, 2);
    assert.deepEqual(registry.hits, ['first', 'page-2']);
  } finally {
    await registry.close();
  }
});

test('registry entries are adapted into runnable instructions', async () => {
  const registry = await startRegistry(PAGES);
  try {
    const { servers } = await collectServers([
      { id: 'official-registry', type: 'registry', url: registry.url },
    ]);
    const weather = findServer(servers, 'io.github.acme/weather').manifest;
    assert.equal(weather.run.command, 'npx');
    assert.deepEqual(weather.run.args, ['-y', '@acme/weather@1.0.0']);

    const notes = findServer(servers, 'io.github.acme/notes').manifest;
    assert.equal(notes.run.type, 'http');
    assert.equal(notes.run.url, 'https://mcp.acme.com/mcp');
  } finally {
    await registry.close();
  }
});

test('a remote-only registry entry needs no package', () => {
  const manifest = fromRegistryServer({
    server: {
      name: 'io.github.acme/notes',
      version: '2.0.0',
      remotes: [{ url: 'https://mcp.acme.com/mcp' }],
    },
  });
  assert.deepEqual(manifest.packages, []);
  assert.equal(manifest.run.url, 'https://mcp.acme.com/mcp');
});

test('an unreachable source degrades to a warning', async () => {
  const { servers, warnings } = await collectServers([
    { id: 'dead', type: 'registry', url: 'http://127.0.0.1:1/v0/servers' },
  ]);
  assert.deepEqual(servers, []);
  assert.equal(warnings[0].code, 'SOURCE_UNAVAILABLE');
  assert.equal(warnings[0].severity, 'warn');
});

test('an unknown source type is reported, not fatal', async () => {
  const { warnings } = await collectServers([
    { id: 'odd', type: 'ftp', url: 'x' },
  ]);
  assert.equal(warnings[0].code, 'UNKNOWN_SOURCE');
});

test('findServer returns null instead of throwing', async () => {
  const { servers } = await collectServers(
    [
      {
        id: 'local-examples',
        type: 'marketplace',
        path: './examples/marketplace.json',
      },
    ],
    { baseDir: ROOT }
  );
  assert.equal(findServer(servers, 'io.example/missing'), null);
});

test('version rows for one server collapse to the newest build', async () => {
  const registry = await startRegistry([
    {
      servers: [
        {
          server: {
            name: 'ai.example/busy',
            version: '1.0.0',
            packages: [
              {
                registryType: 'npm',
                identifier: '@example/busy',
                version: '1.0.0',
              },
            ],
          },
        },
        {
          server: {
            name: 'ai.example/busy',
            version: '2.1.0',
            packages: [
              {
                registryType: 'npm',
                identifier: '@example/busy',
                version: '2.1.0',
              },
            ],
          },
        },
      ],
      metadata: {},
    },
  ]);
  try {
    const { servers, warnings } = await collectServers([
      { id: 'official-registry', type: 'registry', url: registry.url },
    ]);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].manifest.version, '2.1.0');
    assert.ok(warnings.some((entry) => entry.code === 'SOURCE_DUPLICATES'));
  } finally {
    await registry.close();
  }
});

test('--all-versions keeps every published row', async () => {
  const registry = await startRegistry([
    {
      servers: [
        { server: { name: 'ai.example/busy', version: '1.0.0', packages: [] } },
        { server: { name: 'ai.example/busy', version: '2.1.0', packages: [] } },
      ],
      metadata: {},
    },
  ]);
  try {
    const { servers } = await collectServers(
      [{ id: 'official-registry', type: 'registry', url: registry.url }],
      { allVersions: true }
    );
    assert.equal(servers.length, 2);
  } finally {
    await registry.close();
  }
});

test('a crawl that stops at the page cap says so', async () => {
  const registry = await startRegistry(PAGES);
  try {
    const { warnings } = await collectServers(
      [{ id: 'official-registry', type: 'registry', url: registry.url }],
      { maxPages: 1 }
    );
    const truncated = warnings.find(
      (entry) => entry.code === 'SOURCE_TRUNCATED'
    );
    assert.ok(truncated);
    assert.equal(truncated.severity, 'warn');
  } finally {
    await registry.close();
  }
});

test('compareVersions puts a prerelease below its release', () => {
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
  assert.equal(compareVersions('3.1.0', '3.1.0'), 0);
});

test('a marketplace can be published on any static host', async () => {
  const payloads = {
    '/marketplace.json': await readFile(
      path.join(ROOT, 'examples/marketplace.json'),
      'utf8'
    ),
    '/servers/weather.json': await readFile(
      path.join(ROOT, 'examples/servers/weather.json'),
      'utf8'
    ),
    '/servers/notes.json': await readFile(
      path.join(ROOT, 'examples/servers/notes.json'),
      'utf8'
    ),
  };
  const server = createServer((request, response) => {
    const body = payloads[request.url];
    if (!body) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const { servers, warnings } = await collectServers([
      {
        id: 'hosted',
        type: 'marketplace',
        url: `http://127.0.0.1:${port}/marketplace.json`,
      },
    ]);
    assert.deepEqual(
      servers.map((entry) => entry.manifest.name),
      ['com.acme/notes', 'io.example/weather']
    );
    assert.deepEqual(warnings, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a hosted index that 404s degrades to a warning', async () => {
  const server = createServer((request, response) => {
    response.writeHead(404).end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const { servers, warnings } = await collectServers([
      {
        id: 'hosted',
        type: 'marketplace',
        url: `http://127.0.0.1:${port}/marketplace.json`,
      },
    ]);
    assert.deepEqual(servers, []);
    assert.equal(warnings[0].code, 'SOURCE_UNAVAILABLE');
    assert.match(warnings[0].message, /404/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
