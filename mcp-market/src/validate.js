import { isPinnedVersion, isReverseDns, namespaceOf } from './manifest.js';

const HAS_TEMPLATE_TOKEN = /(?<!\$)\{[a-z0-9_-]+\}/i;
const TEMPLATE_TOKEN_ALL = /(?<!\$)\{[a-z0-9_-]+\}/gi;

const PROVEN_IDENTITIES = new Set([
  'dns-txt',
  'github-org',
  'signed-manifest',
  'sigstore',
]);

function issue(code, severity, field, message, hint) {
  return { code, severity, field, message, hint };
}

function error(code, field, message, hint) {
  return issue(code, 'error', field, message, hint);
}

function warn(code, field, message, hint) {
  return issue(code, 'warn', field, message, hint);
}

function hostPartOf(url) {
  const separator = url.indexOf('://');
  if (separator === -1) return '';
  return url.slice(separator + 3).split('/')[0];
}

function allowedHosts(manifest) {
  const hosts = new Set();
  const namespace = manifest.publisher.namespace || namespaceOf(manifest.name);
  if (namespace) {
    hosts.add(namespace.toLowerCase());
    hosts.add(namespace.split('.').reverse().join('.').toLowerCase());
  }
  if (manifest.publisher.url) {
    try {
      hosts.add(new URL(manifest.publisher.url).hostname.toLowerCase());
    } catch {
      // A malformed publisher URL is reported by BAD_URL, not here.
    }
  }
  for (const domain of manifest.publisher.domains) {
    hosts.add(String(domain).toLowerCase());
  }
  return [...hosts].filter(Boolean);
}

function hostAllowed(host, hosts) {
  const normalized = host.toLowerCase();
  return hosts.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`)
  );
}

function permissionEntries(permissions) {
  return Object.entries(permissions).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object')
      return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

function headerTemplates(manifest) {
  const values = [];
  if (manifest.auth.value) values.push(['auth.value', manifest.auth.value]);
  for (const [key, value] of Object.entries(manifest.auth.headers)) {
    values.push([`auth.headers.${key}`, value]);
  }
  for (const [key, value] of Object.entries(manifest.run.headers)) {
    values.push([`run.headers.${key}`, value]);
  }
  return values.filter(([, value]) => typeof value === 'string');
}

export function validateManifest(manifest) {
  const issues = [];
  const { name, version, publisher, run, packages, permissions } = manifest;

  if (!isReverseDns(name)) {
    issues.push(
      error(
        'BAD_NAME',
        'name',
        'name must be a reverse-DNS identifier, e.g. com.example/weather',
        'The prefix before "/" is the namespace the publisher must prove.'
      )
    );
  } else if (publisher.namespace !== namespaceOf(name)) {
    issues.push(
      error(
        'NAMESPACE_MISMATCH',
        'publisher.namespace',
        `publisher.namespace "${publisher.namespace || '(missing)'}" does not own "${namespaceOf(name)}"`,
        'Without a matching namespace the index is a public noticeboard.'
      )
    );
  }

  if (!version) {
    issues.push(warn('MISSING_VERSION', 'version', 'manifest has no version'));
  } else if (!isPinnedVersion(version)) {
    issues.push(
      error(
        'BAD_VERSION',
        'version',
        `version "${version}" is not an exact semver`,
        'A range cannot be resolved by a loader that never sees the artifact.'
      )
    );
  }

  if (run.type === 'stdio') {
    if (!run.command) {
      issues.push(
        error(
          'NO_RUN_INSTRUCTION',
          'run.command',
          'stdio manifest declares no run.command',
          'An MCP server is an external process; it cannot infer a launcher.'
        )
      );
    }
  } else if (run.type === 'http') {
    if (!run.url) {
      issues.push(
        error(
          'NO_RUN_INSTRUCTION',
          'run.url',
          'http manifest declares no run.url'
        )
      );
    } else {
      const host = hostPartOf(run.url);
      if (HAS_TEMPLATE_TOKEN.test(host)) {
        issues.push(
          error(
            'VARIABLE_IN_HOST',
            'run.url',
            'endpoint host contains a template variable',
            'A variable cannot move the origin; only the path may be templated.'
          )
        );
      }
      let hostname = '';
      try {
        hostname = new URL(run.url.replace(TEMPLATE_TOKEN_ALL, 'x')).hostname;
      } catch {
        issues.push(
          error('BAD_URL', 'run.url', `"${run.url}" is not a valid URL`)
        );
      }
      if (hostname && !hostAllowed(hostname, allowedHosts(manifest))) {
        issues.push(
          warn(
            'REMOTE_DOMAIN_MISMATCH',
            'run.url',
            `endpoint ${hostname} does not belong to ${publisher.namespace || namespaceOf(name)}`,
            'The official registry does not check this; a hijacked entry lands here.'
          )
        );
      }
    }
  } else {
    issues.push(
      error(
        'UNKNOWN_TRANSPORT',
        'run.type',
        `unsupported transport "${run.type}"`,
        'Supported: stdio, http.'
      )
    );
  }

  const declaredHeaders = headerTemplates(manifest);
  const templatedHeader = declaredHeaders.find(([, value]) =>
    HAS_TEMPLATE_TOKEN.test(value)
  );
  if (templatedHeader) {
    issues.push(
      error(
        'VARIABLE_IN_HEADER',
        templatedHeader[0],
        'header value contains a template variable',
        'Substituting a tenant slug into a header yields 401 at runtime; prompt for it instead.'
      )
    );
  }

  for (const declared of packages) {
    if (!isPinnedVersion(declared.version)) {
      issues.push(
        warn(
          'UNPINNED_PACKAGE',
          'packages',
          'no package version; the pointer can drift under the user'
        )
      );
      break;
    }
  }

  if (run.type === 'stdio' && packages.length > 0) {
    const launchLine = [run.command, ...run.args].join(' ');
    const referenced = packages.some(
      (declared) =>
        declared.identifier && launchLine.includes(declared.identifier)
    );
    if (!referenced) {
      issues.push(
        warn(
          'ENTRY_PACKAGE_MISMATCH',
          'run.args',
          'launch command does not reference any declared package identifier',
          'Cheap pointer-rot detector: the declared package is no longer what runs.'
        )
      );
    }
  }

  if (permissionEntries(permissions).length === 0) {
    issues.push(
      warn(
        'NO_PERMISSIONS',
        'permissions',
        'no permissions declared',
        'Hosts may refuse to install an undeclared server.'
      )
    );
  }

  if (!PROVEN_IDENTITIES.has(publisher.verifiedBy)) {
    issues.push(
      warn(
        'SELF_ASSERTED',
        'publisher.verifiedBy',
        'identity is self-asserted, not proven',
        'Acceptable for local manifests, not for anything you redistribute.'
      )
    );
  }

  return issues;
}

export function isBlocking(issues, { strict = false } = {}) {
  return issues.some((entry) => (strict ? true : entry.severity === 'error'));
}

export function formatIssue(entry, file = '-') {
  return `${entry.severity.padEnd(5)} ${file} ${entry.code}: ${entry.message}`;
}
