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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  carryAuth,
  isHintValue,
  missingHeaderNames,
  type AuthWarning,
} from '@/lib/mcpAuth';

const CASES = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../test/fixtures/mcp-auth-cases.json'),
    'utf-8'
  )
).cases as Array<{
  id: string;
  field: string;
  input: unknown;
  value: Record<string, string> | null;
  warnings: string[];
}>;

describe('carryAuth', () => {
  it.each(CASES.map((item) => [item.id, item] as const))(
    'matches the shared table: %s',
    (_id, item) => {
      const result = carryAuth(item.input, item.field);
      expect(result.value).toEqual(item.value);
      expect(result.warnings.map((w: AuthWarning) => w.code)).toEqual(
        item.warnings
      );
    }
  );

  it('refuses a list instead of inventing a header map', () => {
    expect(() => carryAuth([{ name: 'x-api-key' }])).toThrow(
      /must be an object/
    );
  });
});

describe('missingHeaderNames', () => {
  it('names every field the install form still has to ask for', () => {
    expect(
      missingHeaderNames({
        Authorization: '${ACME_KEY}',
        'x-api-key': '{{get one}}',
        'x-region': 'eu',
        'x-empty': '   ',
      })
    ).toEqual(['Authorization', 'x-api-key', 'x-empty']);
  });

  it('treats an absent headers object as nothing to ask', () => {
    expect(missingHeaderNames(undefined)).toEqual([]);
    expect(missingHeaderNames({})).toEqual([]);
  });
});

describe('isHintValue', () => {
  it('knows both catalogue spellings', () => {
    expect(isHintValue('${ACME_KEY}')).toBe(true);
    expect(isHintValue('{{get one at exa.ai}}')).toBe(true);
    expect(isHintValue('sk-live-123')).toBe(false);
    expect(isHintValue('Bearer sk-live-123')).toBe(false);
    expect(isHintValue(42)).toBe(false);
  });
});
