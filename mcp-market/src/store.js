import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function bucketFor(target, config) {
  return target === 'vscode' ? config.servers : config.mcpServers;
}

export async function readConfig(file) {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError(
        'BAD_CONFIG',
        `${file} does not contain a JSON object`
      );
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new StoreError(
        'BAD_CONFIG',
        `${file} is not valid JSON: ${error.message}`
      );
    }
    throw error;
  }
}

export async function writeConfig(
  file,
  config,
  { target, force = false } = {}
) {
  const bucket = bucketFor(target, config);
  const keys = Object.keys(bucket ?? {});
  if (keys.length !== 1) {
    throw new StoreError(
      'BAD_CONFIG',
      `expected exactly one server to write, received ${keys.length}`
    );
  }
  const key = keys[0];

  const existing =
    (await readConfig(file)) ||
    (target === 'vscode' ? { inputs: [], servers: {} } : { mcpServers: {} });
  const existingBucket = bucketFor(target, existing);
  if (!existingBucket || typeof existingBucket !== 'object') {
    throw new StoreError(
      'BAD_CONFIG',
      `${file} has no ${target === 'vscode' ? 'servers' : 'mcpServers'} object`
    );
  }
  if (existingBucket[key] && !force) {
    throw new StoreError(
      'ALREADY_INSTALLED',
      `${key} is already installed in ${file}; pass --force to replace it`
    );
  }

  const merged = { ...existing };
  if (target === 'vscode') {
    const known = new Set((merged.inputs ?? []).map((entry) => entry.id));
    const additions = (config.inputs ?? []).filter(
      (entry) => !known.has(entry.id)
    );
    merged.inputs = [...(merged.inputs ?? []), ...additions];
    merged.servers = { ...existingBucket, [key]: bucket[key] };
  } else {
    merged.mcpServers = { ...existingBucket, [key]: bucket[key] };
  }

  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await rename(temporary, file);

  return {
    file,
    key,
    action: existingBucket[key] ? 'replaced' : 'added',
  };
}
