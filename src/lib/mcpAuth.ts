// ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========

/**
 * The renderer's single copy of "is this a credential or a catalogue hint".
 *
 * The same judgement exists three times in this repo, because it runs in three
 * processes that cannot share a module:
 *
 *   server/app/core/mcp_auth.py     canonical (install + import)
 *   backend/app/service/mcp_config.py  Brain, last gate before mcp.json
 *   src/lib/mcpAuth.ts              this file (dialog + install request)
 *
 * They are pinned to one case table -- test/fixtures/mcp-auth-cases.json -- so
 * a definition that drifts fails a test instead of turning into a 401 nobody
 * can attribute. Before this file, the renderer knew about `{{...}}` but not
 * `${VAR}`: a catalogue row spelled `${ACME_KEY}` skipped the "ask for it"
 * dialog entirely and went out as a literal.
 */

/** `{{a sentence}}` or `${VAR}` -- documentation, never a credential. */
export const HINT_PATTERN = /\{\{|\}\}|\$\{[A-Za-z0-9_]+\}/;

export function isHintValue(value: unknown): boolean {
  return typeof value === 'string' && HINT_PATTERN.test(value);
}

/** True when the value is missing, empty, or still a placeholder. */
export function isUnusableValue(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '' || isHintValue(value);
}

export interface AuthWarning {
  code: 'AUTH_VALUE_BLANKED' | 'AUTH_KEY_DROPPED';
  field: string;
  key: string;
}

/**
 * Copy a server's auth map, keeping keys and blanking documentation.
 *
 * Mirrors `carry_auth` in server/app/core/mcp_auth.py. Returns a new object;
 * `null` means "there is nothing to store", which is what a JSON column wants.
 */
export function carryAuth(
  src: unknown,
  field = 'headers'
): { value: Record<string, string> | null; warnings: AuthWarning[] } {
  const warnings: AuthWarning[] = [];
  if (src === null || src === undefined) return { value: null, warnings };
  if (typeof src !== 'object' || Array.isArray(src)) {
    throw new Error(`${field} must be an object of key/value pairs`);
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(
    src as Record<string, unknown>
  )) {
    const key = rawKey.trim();
    if (!key) {
      warnings.push({ code: 'AUTH_KEY_DROPPED', field, key: rawKey });
      continue;
    }
    if (isHintValue(rawValue)) {
      out[key] = '';
      warnings.push({ code: 'AUTH_VALUE_BLANKED', field, key });
      continue;
    }
    out[key] = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
  }
  return {
    value: Object.keys(out).length > 0 ? out : null,
    warnings,
  };
}

/** Names of the headers the install form still has to ask the user for. */
export function missingHeaderNames(headers: unknown): string[] {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return [];
  }
  return Object.entries(headers as Record<string, unknown>)
    .filter(([, value]) => isUnusableValue(value))
    .map(([name]) => name);
}
