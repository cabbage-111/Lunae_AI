import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

export const DEFAULT_SOURCES = path.join(ROOT, 'sources.default.json');

export function defaultConfigPath(target, cwd = process.cwd()) {
  if (target === 'vscode') return path.join(cwd, '.vscode', 'mcp.json');
  if (target === 'portable') return path.join(cwd, 'mcp.json');
  return null;
}

export const MANIFEST_TEMPLATE = {
  name: 'com.example/hello',
  version: '0.1.0',
  description:
    'Minimal MCP server manifest. Replace every example value before publishing.',
  publisher: {
    namespace: 'com.example',
    displayName: 'Example Inc.',
    url: 'https://example.com',
    verifiedBy: 'dns-txt',
  },
  run: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/hello-mcp@0.1.0'],
  },
  packages: [
    {
      registry: 'npm',
      identifier: '@example/hello-mcp',
      version: '0.1.0',
    },
  ],
  permissions: {
    network: ['example.com'],
  },
};
