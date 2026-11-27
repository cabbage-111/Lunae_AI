#!/usr/bin/env node
import { parseArgs } from 'node:util';

import {
  runAdd,
  runCatalog,
  runIndex,
  runInit,
  runList,
  runShow,
  runVerify,
} from './commands.js';

const HELP = `mcp-market <command> [options]

  list                     list servers from the configured sources
    -s, --source <file>    sources file (default: ./sources.default.json)
        --registry         registry sources only, follow every page
        --max-pages <n>    page cap for --registry (default: 20)
        --all-versions     keep every published version row
        --json             machine-readable output
  show <name>              print a manifest and its findings
  add <name> -t <target>   render or install a server config
    -t, --target <name>    vscode | portable | link
        --var k=v          fill a URL template variable (repeatable)
        --write            write into the target config file
        --config <file>    config destination (implies --write)
        --force            replace an existing server entry
  init [dir]               write an mcp-manifest.json template
        --force            overwrite an existing manifest
  index [dir]              build a marketplace.json from a directory of manifests
        --out <file>       index destination (default: <dir>/marketplace.json)
        --skip-invalid     index the valid manifests, list the rest
  verify [files...]        validate manifests (default: ./mcp-manifest.json)
        --strict           treat warnings as failures
        --json             machine-readable output
  catalog                  project the sources into market rows (for the seed script)
    -s, --source <file>    sources file (default: ./sources.default.json)
        --out <file>       write the JSON envelope
        --skip-invalid     write the rows that can be written, list the rest
        --all-versions     keep every published version row
        --json             print the envelope to stdout

exit codes: 0 ok, 1 rejected, 2 usage`;

function parseVars(pairs) {
  const values = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) {
      throw new Error(`--var expects key=value, received "${pair}"`);
    }
    values[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return values;
}

function print(result) {
  if (result.text) process.stdout.write(`${result.text}\n`);
  process.exitCode = result.code;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: 'string', short: 't' },
      var: { type: 'string', multiple: true, default: [] },
      write: { type: 'boolean', default: false },
      config: { type: 'string' },
      force: { type: 'boolean', default: false },
      source: { type: 'string', short: 's' },
      registry: { type: 'boolean', default: false },
      'all-versions': { type: 'boolean', default: false },
      'max-pages': { type: 'string' },
      out: { type: 'string' },
      'skip-invalid': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];
  if (!command || command === 'help' || values.help) {
    process.stdout.write(`${HELP}\n`);
    process.exitCode = 0;
    return;
  }

  const sourcesFile = values.source;
  const maxPages = values['max-pages'] ? Number(values['max-pages']) : 20;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    process.stderr.write('--max-pages expects a positive integer\n');
    process.exitCode = 2;
    return;
  }

  if (command === 'list') {
    print(
      await runList({
        sourcesFile: sourcesFile ?? undefined,
        onlyRegistry: values.registry,
        maxPages,
        allVersions: values['all-versions'],
        json: values.json,
      })
    );
    return;
  }

  if (command === 'show') {
    const name = positionals[1];
    if (!name) {
      process.stderr.write('show expects a server name\n');
      process.exitCode = 2;
      return;
    }
    print(
      await runShow(name, { sourcesFile: sourcesFile ?? undefined, maxPages })
    );
    return;
  }

  if (command === 'add') {
    const name = positionals[1];
    if (!name || !values.target) {
      process.stderr.write('add expects a server name and -t <target>\n');
      process.exitCode = 2;
      return;
    }
    let vars;
    try {
      vars = parseVars(values.var);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    print(
      await runAdd(name, {
        target: values.target,
        vars,
        write: values.write || Boolean(values.config),
        config: values.config,
        force: values.force,
        sourcesFile: sourcesFile ?? undefined,
        maxPages,
      })
    );
    return;
  }

  if (command === 'init') {
    print(
      await runInit({
        dir: positionals[1] ?? process.cwd(),
        force: values.force,
      })
    );
    return;
  }

  if (command === 'index') {
    print(
      await runIndex({
        dir: positionals[1] ?? process.cwd(),
        out: values.out,
        skipInvalid: values['skip-invalid'],
      })
    );
    return;
  }

  if (command === 'catalog') {
    print(
      await runCatalog({
        sourcesFile: sourcesFile ?? undefined,
        maxPages,
        allVersions: values['all-versions'],
        out: values.out,
        json: values.json,
        skipInvalid: values['skip-invalid'],
      })
    );
    return;
  }

  if (command === 'verify') {
    print(
      await runVerify({
        files: positionals.slice(1),
        strict: values.strict,
        json: values.json,
      })
    );
    return;
  }

  process.stderr.write(`unknown command "${command}"\n\n${HELP}\n`);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
