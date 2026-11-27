import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildCatalog, catalogEnvelope } from './catalog.js';
import { EmitError, assertTarget, emitConfig } from './emit.js';
import { loadManifestFile, normalizeManifest } from './manifest.js';
import {
  DEFAULT_SOURCES,
  MANIFEST_TEMPLATE,
  defaultConfigPath,
} from './paths.js';
import { collectServers, findServer, loadSources } from './sources.js';
import { writeConfig } from './store.js';
import { formatIssue, isBlocking, validateManifest } from './validate.js';

function permissionsSummary(manifest) {
  const declared = Object.entries(manifest.permissions).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  );
  if (declared.length === 0) return 'UNDECLARED';
  return declared
    .map(
      ([key, value]) =>
        `${key}=${Array.isArray(value) ? value.join(',') : value}`
    )
    .join(' ');
}

async function looksLikeFile(name) {
  if (name.endsWith('.json')) return true;
  try {
    const info = await stat(name);
    return info.isFile();
  } catch {
    return false;
  }
}

async function resolveManifest(
  name,
  { sourcesFile, fetchImpl, maxPages, baseDir }
) {
  if (await looksLikeFile(name)) {
    return { manifest: await loadManifestFile(name), source: 'file' };
  }
  const sources = await loadSources(sourcesFile);
  const { servers } = await collectServers(sources, {
    fetchImpl,
    maxPages,
    baseDir,
  });
  const found = findServer(servers, name);
  if (!found) {
    throw new Error(
      `no server named "${name}" in ${sources.length} source(s); run "list" to see what is reachable`
    );
  }
  return found;
}

export async function runList(options = {}) {
  const {
    sourcesFile = DEFAULT_SOURCES,
    onlyRegistry = false,
    maxPages = 20,
    json = false,
    allVersions = false,
    fetchImpl,
  } = options;
  const sources = await loadSources(sourcesFile);
  const selected = onlyRegistry
    ? sources.filter((source) => source.type === 'registry')
    : sources;
  if (selected.length === 0) {
    return { code: 1, text: 'no registry sources configured' };
  }

  const { servers, warnings } = await collectServers(selected, {
    fetchImpl,
    maxPages,
    allVersions,
    baseDir: path.dirname(path.resolve(sourcesFile)),
  });

  if (json) {
    return {
      code: 0,
      text: JSON.stringify(
        {
          servers: servers.map((entry) => ({
            name: entry.manifest.name,
            version: entry.manifest.version,
            description: entry.manifest.description,
            source: entry.source,
          })),
          warnings,
        },
        null,
        2
      ),
    };
  }

  const lines = [];
  for (const warning of warnings) {
    lines.push(
      `${warning.severity.padEnd(5)} ${warning.source} ${warning.code}: ${warning.message}`
    );
  }
  const width = servers.reduce(
    (max, entry) => Math.max(max, entry.manifest.name.length),
    0
  );
  for (const entry of servers) {
    const { name, version } = entry.manifest;
    lines.push(
      `${name.padEnd(width)}  ${(version || '-').padEnd(10)}  [${entry.source}]`
    );
  }
  lines.push('');
  lines.push(`${servers.length} server(s) from ${selected.length} source(s)`);
  return { code: 0, text: lines.join('\n'), servers };
}

export async function runShow(name, options = {}) {
  const { sourcesFile = DEFAULT_SOURCES, fetchImpl, maxPages = 20 } = options;
  const { manifest, source } = await resolveManifest(name, {
    sourcesFile,
    fetchImpl,
    maxPages,
    baseDir: path.dirname(path.resolve(sourcesFile)),
  });
  const issues = validateManifest(manifest);
  const lines = [
    `${manifest.name}  ${manifest.version || '-'}  [${source}]`,
    '',
  ];
  for (const entry of issues) lines.push(formatIssue(entry, manifest.name));
  lines.push('', JSON.stringify(manifest.raw, null, 2));
  return {
    code: isBlocking(issues) ? 1 : 0,
    text: lines.join('\n'),
    manifest,
    issues,
  };
}

export async function runAdd(name, options = {}) {
  const {
    target,
    vars = {},
    write = false,
    config,
    force = false,
    sourcesFile = DEFAULT_SOURCES,
    cwd = process.cwd(),
    fetchImpl,
    maxPages = 20,
  } = options;

  try {
    assertTarget(target);
  } catch (error) {
    return { code: 2, text: `${error.code ?? 'BAD_TARGET'}: ${error.message}` };
  }

  let resolved;
  try {
    resolved = await resolveManifest(name, {
      sourcesFile,
      fetchImpl,
      maxPages,
      baseDir: path.dirname(path.resolve(sourcesFile)),
    });
  } catch (error) {
    return {
      code: 1,
      text: `error ${error.code ?? 'NOT_FOUND'}: ${error.message}`,
    };
  }

  const { manifest, source } = resolved;
  const issues = validateManifest(manifest);
  const lines = [`${manifest.name}  ${manifest.version || '-'}  [${source}]`];
  for (const entry of issues) lines.push(formatIssue(entry, manifest.name));
  lines.push(`permissions: ${permissionsSummary(manifest)}`);

  if (isBlocking(issues)) {
    lines.push(
      '',
      'refusing to install: the manifest cannot describe a runnable server'
    );
    return { code: 1, text: lines.join('\n'), issues };
  }

  let emitted;
  try {
    emitted = emitConfig(manifest, { target, values: vars });
  } catch (error) {
    if (error instanceof EmitError) {
      lines.push(`error ${error.code}: ${error.message}`);
      return { code: 1, text: lines.join('\n'), issues };
    }
    throw error;
  }

  if (target === 'link') {
    lines.push('', emitted);
    return { code: 0, text: lines.join('\n'), issues, link: emitted };
  }

  const rendered = JSON.stringify(emitted, null, 2);
  if (!write) {
    lines.push('', rendered);
    return { code: 0, text: lines.join('\n'), issues, config: emitted };
  }

  const destination = config || defaultConfigPath(target, cwd);
  try {
    const result = await writeConfig(destination, emitted, { target, force });
    lines.push(
      '',
      `installed ${result.key} -> ${result.file} (${result.action})`
    );
    return {
      code: 0,
      text: lines.join('\n'),
      issues,
      config: emitted,
      written: result,
    };
  } catch (error) {
    lines.push('', `error ${error.code ?? 'WRITE_FAILED'}: ${error.message}`);
    return { code: 1, text: lines.join('\n'), issues };
  }
}

async function verifyFile(file, { strict }) {
  const lines = [];
  let issues = [];
  try {
    const manifest = await loadManifestFile(file);
    issues = validateManifest(manifest);
  } catch (error) {
    issues = [
      {
        code: 'UNREADABLE',
        severity: 'error',
        field: '',
        message: error.message,
      },
    ];
  }
  const label = path.basename(file);
  for (const entry of issues) lines.push(formatIssue(entry, label));
  return { file, issues, blocking: isBlocking(issues, { strict }), lines };
}

export async function runVerify(options = {}) {
  const {
    files = [],
    cwd = process.cwd(),
    strict = false,
    json = false,
  } = options;
  const targets =
    files.length > 0 ? files : [path.join(cwd, 'mcp-manifest.json')];

  const results = [];
  for (const file of targets) {
    results.push(await verifyFile(file, { strict }));
  }

  const errors = results.reduce(
    (total, result) =>
      total +
      result.issues.filter((entry) => entry.severity === 'error').length,
    0
  );
  const warnings = results.reduce(
    (total, result) =>
      total + result.issues.filter((entry) => entry.severity === 'warn').length,
    0
  );
  const blocking = results.some((result) => result.blocking);

  if (json) {
    return {
      code: blocking ? 1 : 0,
      text: JSON.stringify({ results, errors, warnings, strict }, null, 2),
    };
  }

  const lines = results.flatMap((result) => result.lines);
  lines.push('');
  lines.push(
    `${results.length} file(s), ${errors} error(s), ${warnings} warning(s)${strict ? ' (strict)' : ''}`
  );
  if (blocking) {
    lines.push(
      strict
        ? 'result: FAIL (strict treats warnings as failures)'
        : 'result: FAIL'
    );
  } else {
    lines.push('result: OK');
  }
  return { code: blocking ? 1 : 0, text: lines.join('\n'), errors, warnings };
}

export async function runInit(options = {}) {
  const { cwd = process.cwd(), dir = cwd, force = false } = options;
  const target = path.join(path.resolve(dir), 'mcp-manifest.json');

  try {
    await stat(target);
    if (!force) {
      return {
        code: 1,
        text: `${target} already exists; pass --force to overwrite it`,
      };
    }
  } catch {
    // Missing file is the expected path.
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify(MANIFEST_TEMPLATE, null, 2)}\n`,
    'utf8'
  );
  return {
    code: 0,
    text: [
      `wrote ${target}`,
      '',
      'next:',
      '  1. replace com.example/hello, publisher.namespace and publisher.url',
      '  2. run: node src/cli.js verify mcp-manifest.json --strict',
      '  3. publish the proof you declared in publisher.verifiedBy',
    ].join('\n'),
    file: target,
  };
}

export async function readJsonFile(file) {
  return normalizeManifest(JSON.parse(await readFile(file, 'utf8')));
}

export async function runIndex(options = {}) {
  const { dir = process.cwd(), out, skipInvalid = false } = options;
  const source = path.resolve(dir);

  let names;
  try {
    names = await readdir(source);
  } catch (error) {
    return { code: 1, text: `error UNREADABLE_DIR: ${error.message}` };
  }

  const files = names
    .filter((name) => name.endsWith('.json') && name !== 'marketplace.json')
    .sort();

  const lines = [];
  const accepted = [];
  const rejected = [];

  for (const file of files) {
    const full = path.join(source, file);
    let manifest;
    let issues;
    try {
      manifest = await loadManifestFile(full);
      issues = validateManifest(manifest);
    } catch (error) {
      rejected.push(file);
      lines.push(`error ${file} UNREADABLE: ${error.message}`);
      continue;
    }
    const errors = issues.filter((entry) => entry.severity === 'error');
    const warnings = issues.filter((entry) => entry.severity === 'warn');
    if (errors.length > 0) {
      rejected.push(file);
      lines.push(
        `error ${file} ${manifest.name || '(no name)'}  ${errors.map((entry) => entry.code).join(', ')}`
      );
      continue;
    }
    accepted.push(file);
    lines.push(
      `ok    ${file} ${manifest.name}${warnings.length > 0 ? `  warn: ${warnings.map((entry) => entry.code).join(', ')}` : ''}`
    );
  }

  if (rejected.length > 0 && !skipInvalid) {
    lines.push(
      '',
      `refusing to index ${rejected.length} invalid manifest(s); fix them or pass --skip-invalid`
    );
    return { code: 1, text: lines.join('\n') };
  }

  if (accepted.length === 0) {
    lines.push('', 'no valid manifest found; nothing written');
    return { code: 1, text: lines.join('\n') };
  }

  const target = out
    ? path.resolve(out)
    : path.join(source, 'marketplace.json');

  const entries = accepted.map((file) => {
    const relative = path
      .relative(path.dirname(target), path.join(source, file))
      .split(path.sep)
      .join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  });

  const index = { name: path.basename(source), servers: entries };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  lines.push(
    '',
    `wrote ${target} (${entries.length} server(s)${rejected.length > 0 ? `, ${rejected.length} skipped` : ''})`
  );
  return { code: 0, text: lines.join('\n'), file: target, entries };
}

/**
 * Project the reachable servers into the row shape the Python seed script
 * inserts. This is the bridge between "who publishes what" and "what the
 * `mcp` table holds": the loader stays the only place that knows manifests,
 * the seed script stays the only place that knows the schema.
 */
export async function runCatalog(options = {}) {
  const {
    sourcesFile = DEFAULT_SOURCES,
    maxPages = 20,
    allVersions = false,
    out,
    json = false,
    skipInvalid = false,
    fetchImpl,
  } = options;

  const sources = await loadSources(sourcesFile);
  const { servers, warnings: sourceWarnings } = await collectServers(sources, {
    fetchImpl,
    maxPages,
    allVersions,
    baseDir: path.dirname(path.resolve(sourcesFile)),
  });

  const catalog = buildCatalog(servers, {
    origin: sources.map((source) => source.id),
  });
  const envelope = catalogEnvelope(catalog);
  envelope.warnings = [...sourceWarnings, ...catalog.warnings];

  const lines = [];
  for (const entry of catalog.rejected) {
    lines.push(`error ${entry.name} ${entry.reason}: ${entry.detail}`.trim());
  }
  for (const record of catalog.records) {
    const endpoint =
      record.install_command.url ??
      `${record.install_command.command} ${(record.install_command.args ?? []).join(' ')}`.trim();
    const kind = record.type === 2 ? 'remote' : 'local';
    lines.push(`ok    ${record.manifest}  ${kind}  ${endpoint}`);
  }
  for (const warning of envelope.warnings) {
    if (warning.code === 'ENV_REQUIRED') {
      lines.push(`warn  ${warning.code} ${warning.message}`);
    }
  }

  const blocked = catalog.rejected.length > 0 && !skipInvalid;
  const empty = catalog.records.length === 0;

  if (json) {
    // Always the envelope, even when nothing can be written: the caller parses
    // this to find out *why* rows are missing, so a plain-text refusal would
    // leave it guessing.
    if (out && !blocked && !empty) {
      const target = path.resolve(out);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      envelope.written = target;
    }
    return {
      code: blocked || empty ? 1 : 0,
      text: JSON.stringify(envelope, null, 2),
      records: catalog.records,
      envelope,
    };
  }

  if (blocked) {
    lines.push(
      '',
      `refusing to write: ${catalog.rejected.length} manifest(s) cannot become a row; fix them or pass --skip-invalid`
    );
    return { code: 1, text: lines.join('\n'), rejected: catalog.rejected };
  }

  if (empty) {
    lines.push('', 'no record to write');
    return { code: 1, text: lines.join('\n'), records: [] };
  }

  if (out) {
    const target = path.resolve(out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    lines.push(
      '',
      `wrote ${target} (${catalog.records.length} record(s)${catalog.rejected.length > 0 ? `, ${catalog.rejected.length} skipped` : ''})`
    );
  }

  lines.push('');
  lines.push(
    `${catalog.records.length} record(s) from ${servers.length} server(s)${catalog.rejected.length > 0 ? `, ${catalog.rejected.length} skipped` : ''}`
  );
  if (!out) lines.push('preview only; pass --out <file> to write it');
  return {
    code: 0,
    text: lines.join('\n'),
    records: catalog.records,
    envelope,
  };
}
