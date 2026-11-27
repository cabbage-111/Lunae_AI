export function goodManifest(overrides = {}) {
  return {
    name: 'io.example/weather',
    version: '1.2.0',
    description: 'Current conditions and forecast for a city.',
    publisher: {
      namespace: 'io.example',
      displayName: 'Example Labs',
      url: 'https://example.io',
      verifiedBy: 'dns-txt',
    },
    run: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/weather-mcp@1.2.0'],
    },
    packages: [
      {
        registry: 'npm',
        identifier: '@example/weather-mcp',
        version: '1.2.0',
      },
    ],
    permissions: { network: ['example.io'] },
    ...overrides,
  };
}

export function remoteManifest(overrides = {}) {
  return {
    name: 'io.example/weather',
    version: '1.2.0',
    description: 'Remote weather endpoint.',
    publisher: {
      namespace: 'io.example',
      displayName: 'Example Labs',
      url: 'https://example.io',
      verifiedBy: 'dns-txt',
    },
    run: {
      type: 'http',
      url: 'https://mcp.example.io/mcp',
      headers: { 'x-api-key': '${WEATHER_API_KEY}' },
    },
    permissions: { network: ['mcp.example.io'] },
    ...overrides,
  };
}

export function codes(issues) {
  return issues.map((entry) => entry.code);
}

export function byCode(issues, code) {
  return issues.find((entry) => entry.code === code);
}
