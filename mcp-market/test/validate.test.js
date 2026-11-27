import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeManifest } from '../src/manifest.js';
import { formatIssue, isBlocking, validateManifest } from '../src/validate.js';
import { byCode, codes, goodManifest, remoteManifest } from './helpers.js';

function check(raw) {
  return validateManifest(normalizeManifest(raw));
}

test('a well-formed manifest produces no findings', () => {
  assert.deepEqual(codes(check(goodManifest())), []);
});

test('BAD_NAME rejects a name that is not reversed DNS', () => {
  const issues = check(goodManifest({ name: 'weather' }));
  assert.ok(codes(issues).includes('BAD_NAME'));
  assert.equal(byCode(issues, 'BAD_NAME').severity, 'error');
});

test('NAMESPACE_MISMATCH blocks a publisher that does not own the prefix', () => {
  const issues = check(
    goodManifest({
      publisher: {
        namespace: 'io.someoneelse',
        verifiedBy: 'dns-txt',
      },
    })
  );
  const finding = byCode(issues, 'NAMESPACE_MISMATCH');
  assert.ok(finding);
  assert.equal(finding.severity, 'error');
});

test('NO_RUN_INSTRUCTION blocks a stdio manifest without a command', () => {
  const issues = check(
    goodManifest({
      run: { type: 'stdio', args: ['-y', '@example/weather-mcp@1.2.0'] },
    })
  );
  assert.equal(byCode(issues, 'NO_RUN_INSTRUCTION').severity, 'error');
});

test('NO_RUN_INSTRUCTION blocks an http manifest without a url', () => {
  const issues = check(remoteManifest({ run: { type: 'http' } }));
  assert.ok(codes(issues).includes('NO_RUN_INSTRUCTION'));
});

test('UNKNOWN_TRANSPORT is an error', () => {
  const issues = check(goodManifest({ run: { type: 'carrier-pigeon' } }));
  assert.equal(byCode(issues, 'UNKNOWN_TRANSPORT').severity, 'error');
});

test('SELF_ASSERTED warns when the publisher only says manual', () => {
  const issues = check(
    goodManifest({
      publisher: { namespace: 'io.example', verifiedBy: 'manual' },
    })
  );
  const finding = byCode(issues, 'SELF_ASSERTED');
  assert.ok(finding);
  assert.equal(finding.severity, 'warn');
  assert.equal(finding.message, 'identity is self-asserted, not proven');
});

test('SELF_ASSERTED warns when verifiedBy is missing entirely', () => {
  const issues = check(
    goodManifest({ publisher: { namespace: 'io.example' } })
  );
  assert.ok(codes(issues).includes('SELF_ASSERTED'));
});

test('MISSING_VERSION warns, BAD_VERSION blocks a range', () => {
  assert.ok(
    codes(check(goodManifest({ version: '' }))).includes('MISSING_VERSION')
  );
  const issues = check(goodManifest({ version: '^1.2.0' }));
  assert.equal(byCode(issues, 'BAD_VERSION').severity, 'error');
});

test('UNPINNED_PACKAGE warns when the pointer can drift', () => {
  const issues = check(
    goodManifest({
      packages: [{ registry: 'npm', identifier: '@example/weather-mcp' }],
    })
  );
  const finding = byCode(issues, 'UNPINNED_PACKAGE');
  assert.ok(finding);
  assert.equal(finding.severity, 'warn');
  assert.equal(
    finding.message,
    'no package version; the pointer can drift under the user'
  );
});

test('ENTRY_PACKAGE_MISMATCH warns when launch args lost the package', () => {
  const issues = check(
    goodManifest({
      run: { type: 'stdio', command: 'npx', args: ['-y', 'other-mcp'] },
    })
  );
  const finding = byCode(issues, 'ENTRY_PACKAGE_MISMATCH');
  assert.ok(finding);
  assert.equal(
    finding.message,
    'launch command does not reference any declared package identifier'
  );
});

test('NO_PERMISSIONS warns when nothing is declared', () => {
  const issues = check(goodManifest({ permissions: {} }));
  assert.equal(byCode(issues, 'NO_PERMISSIONS').severity, 'warn');
});

test('REMOTE_DOMAIN_MISMATCH warns when the endpoint escapes the namespace', () => {
  const issues = check(
    remoteManifest({
      run: { type: 'http', url: 'https://mcp.evil.com/mcp' },
    })
  );
  const finding = byCode(issues, 'REMOTE_DOMAIN_MISMATCH');
  assert.ok(finding);
  assert.equal(finding.severity, 'warn');
});

test('REMOTE_DOMAIN_MISMATCH accepts a subdomain of the publisher domain', () => {
  const issues = codes(
    check(
      remoteManifest({
        run: { type: 'http', url: 'https://edge.example.io/mcp' },
      })
    )
  );
  assert.ok(!issues.includes('REMOTE_DOMAIN_MISMATCH'));
});

test('VARIABLE_IN_HEADER blocks a templated header', () => {
  const issues = check(
    remoteManifest({
      run: {
        type: 'http',
        url: 'https://mcp.example.io/mcp',
        headers: { 'x-tenant': '{tenant}' },
      },
    })
  );
  assert.equal(byCode(issues, 'VARIABLE_IN_HEADER').severity, 'error');
});

test('an environment reference in a header is not a template variable', () => {
  const issues = codes(check(remoteManifest()));
  assert.ok(!issues.includes('VARIABLE_IN_HEADER'));
});

test('VARIABLE_IN_HOST blocks a template that moves the origin', () => {
  const issues = check(
    remoteManifest({
      run: { type: 'http', url: 'https://{tenant}.example.io/mcp' },
    })
  );
  assert.equal(byCode(issues, 'VARIABLE_IN_HOST').severity, 'error');
});

test('strict mode treats warnings as blocking, default mode does not', () => {
  const issues = check(goodManifest({ permissions: {} }));
  assert.equal(isBlocking(issues), false);
  assert.equal(isBlocking(issues, { strict: true }), true);
});

test('formatIssue aligns severity and names the file', () => {
  const [finding] = check(goodManifest({ permissions: {} }));
  assert.equal(
    formatIssue(finding, 'drift.json'),
    'warn  drift.json NO_PERMISSIONS: no permissions declared'
  );
});
