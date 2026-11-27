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
 * Brain REST API - MCP and Skills endpoints.
 * All calls go through Brain HTTP API (getBaseURL). No IPC fallback.
 */

import i18next from 'i18next';
import { missingHeaderNames } from '../lib/mcpAuth';
import {
  fetchDelete,
  fetchGet,
  fetchGetBlob,
  fetchPost,
  fetchPostForm,
  fetchPut,
} from './http';

export async function mcpList(): Promise<{
  mcpServers: Record<string, unknown>;
}> {
  const res = await fetchGet('/mcp/list');
  return res && typeof res.mcpServers === 'object' ? res : { mcpServers: {} };
}

/**
 * A remote MCP authenticates with headers. Writing a config whose header value
 * is empty or a catalogue hint does not "install" anything: the request goes
 * out, the server answers 401, and the user has no way to tell a missing key
 * from a wrong one. Brain refuses this too; failing here names the header
 * before the round trip.
 *
 * The judgement lives in `lib/mcpAuth` so this gate and the install dialog
 * cannot disagree about what "a hint" is.
 */
function assertRunnableHeaders(mcp: Record<string, unknown>): void {
  const missing = missingHeaderNames(mcp.headers);
  if (missing.length === 0) return;
  throw new Error(
    `Header "${missing[0]}" has no value. Ask for it before installing: an empty header authenticates nothing.`
  );
}

export async function mcpInstall(
  name: string,
  mcp: Record<string, unknown>
): Promise<{ success: boolean }> {
  assertRunnableHeaders(mcp);
  return fetchPost('/mcp/install', { name, mcp });
}

export async function mcpRemove(name: string): Promise<{ success: boolean }> {
  return fetchDelete(`/mcp/${encodeURIComponent(name)}`);
}

export async function mcpUpdate(
  name: string,
  mcp: Record<string, unknown>
): Promise<{ success: boolean }> {
  return fetchPut(`/mcp/${encodeURIComponent(name)}`, mcp);
}

/**
 * Does this server answer at all, and does it answer with a demand?
 *
 * A 401 that names a protected resource is the only signal that a static
 * header will never work: the server wants a token it issues itself. Asking
 * before installing is cheaper than installing, failing, and guessing why.
 */
export type McpOAuthProbeResult = {
  outcome: 'open' | 'auth_required' | 'unsupported' | 'unreachable';
  detail?: string;
  authorization_server?: string;
  scopes?: string[];
};

export async function mcpOAuthProbe(url: string): Promise<McpOAuthProbeResult> {
  return fetchPost('/mcp/oauth/probe', { url });
}

/**
 * Start authorization. The token stays in Brain: it is written straight into
 * `~/.eigent/mcp.json` by the process that owns the file, so the renderer never
 * holds a credential it could leak into a log or a screenshot.
 */
export async function mcpOAuthStart(
  name: string,
  mcp: Record<string, unknown>
): Promise<{
  authorize_url: string;
  state: string;
  /**
   * True when Brain already opened the login page in the system browser. The
   * renderer must not try a second time, or the user gets two tabs.
   */
  browser_opened?: boolean;
}> {
  return fetchPost('/mcp/oauth/start', { name, mcp });
}

export async function mcpOAuthStatus(
  state: string
): Promise<{
  status: 'pending' | 'authorized' | 'error' | 'unknown';
  detail?: string;
}> {
  return fetchGet(`/mcp/oauth/status/${encodeURIComponent(state)}`);
}

export async function skillsScan(): Promise<{
  success: boolean;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    scope: string;
    skillDirName: string;
    isExample: boolean;
  }>;
}> {
  const res = await fetchGet('/skills');
  return res?.skills !== undefined ? res : { success: true, skills: [] };
}

export async function skillWrite(
  skillDirName: string,
  content: string
): Promise<{ success: boolean }> {
  return fetchPost(`/skills/${encodeURIComponent(skillDirName)}`, { content });
}

export async function skillImportZip(
  zipBuffer: ArrayBuffer,
  replacements?: string[]
): Promise<{
  success: boolean;
  error?: string;
  conflicts?: Array<{ folderName: string; skillName: string }>;
}> {
  const formData = new FormData();
  formData.append('file', new Blob([zipBuffer]), 'skill.zip');
  if (replacements?.length) {
    formData.append('replacements', replacements.join(','));
  }
  const res = await fetchPostForm('/skills/import', formData);
  return (res ?? {
    success: false,
    error: i18next.t('layout.skill-import-failed', {
      defaultValue: 'Import failed',
    }),
  }) as {
    success: boolean;
    error?: string;
    conflicts?: Array<{ folderName: string; skillName: string }>;
  };
}

export async function skillRead(
  skillDirName: string
): Promise<{ success: boolean; content: string }> {
  return fetchGet(`/skills/${encodeURIComponent(skillDirName)}`);
}

const SKILL_REQUEST_TIMEOUT_MS = 30_000;

function skillRequestSignal(): AbortSignal | undefined {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(SKILL_REQUEST_TIMEOUT_MS);
  }
  return undefined;
}

export async function skillDelete(
  skillDirName: string
): Promise<{ success: boolean }> {
  return fetchDelete(
    `/skills/${encodeURIComponent(skillDirName)}`,
    undefined,
    undefined,
    { signal: skillRequestSignal() }
  );
}

export async function skillListFiles(
  skillDirName: string
): Promise<{ success: boolean; files: SkillPackageFile[] }> {
  const res = await fetchGet(
    `/skills/${encodeURIComponent(skillDirName)}/files`
  );
  if (!Array.isArray(res?.files)) return { success: true, files: [] };
  return {
    success: res.success !== false,
    files: res.files.flatMap((file: unknown) => {
      if (typeof file === 'string') {
        return [{ path: file, size: null }];
      }
      if (
        file &&
        typeof file === 'object' &&
        typeof (file as SkillPackageFile).path === 'string'
      ) {
        const entry = file as SkillPackageFile;
        return [
          {
            path: entry.path,
            size: typeof entry.size === 'number' ? entry.size : null,
            mimeType:
              typeof entry.mimeType === 'string' ? entry.mimeType : null,
          },
        ];
      }
      return [];
    }),
  };
}

export type SkillPackageFile = {
  path: string;
  size: number | null;
  mimeType?: string | null;
};

export async function skillReadFile(
  skillDirName: string,
  relativePath: string
): Promise<Blob> {
  return fetchGetBlob(
    `/skills/${encodeURIComponent(skillDirName)}/file`,
    { path: relativePath },
    { signal: skillRequestSignal() }
  );
}

export async function skillGetPathByName(
  skillName: string
): Promise<{ path: string } | null> {
  const res = await fetchGet(
    `/skills/path?name=${encodeURIComponent(skillName)}`
  );
  return res?.path ? { path: res.path } : null;
}

// --- Skill config (REST API, no Electron coupling) ---

export async function skillConfigLoad(
  userId: string,
  legacyUserId?: string | null
): Promise<{ success: boolean; config?: Record<string, unknown> }> {
  const legacyQuery = legacyUserId
    ? `&legacy_user_id=${encodeURIComponent(legacyUserId)}`
    : '';
  const res = await fetchGet(
    `/skills/config?user_id=${encodeURIComponent(userId)}${legacyQuery}`
  );
  return res?.config !== undefined ? res : { success: false };
}

export async function skillConfigInit(
  userId: string,
  legacyUserId?: string | null
): Promise<{ success: boolean; config?: Record<string, unknown> }> {
  const res = await fetchPost('/skills/config/init', {
    user_id: userId,
    ...(legacyUserId ? { legacy_user_id: legacyUserId } : {}),
  });
  return res?.config !== undefined ? res : { success: false };
}

export async function skillConfigUpdate(
  userId: string,
  skillName: string,
  config: {
    enabled?: boolean;
    scope?: { isGlobal?: boolean; selectedAgents?: string[] };
    addedAt?: number;
    isExample?: boolean;
  },
  legacyUserId?: string | null
): Promise<{ success: boolean }> {
  return fetchPut(`/skills/config/${encodeURIComponent(skillName)}`, {
    user_id: userId,
    ...(legacyUserId ? { legacy_user_id: legacyUserId } : {}),
    ...config,
  });
}

export async function skillConfigDelete(
  userId: string,
  skillName: string,
  legacyUserId?: string | null
): Promise<{ success: boolean }> {
  const legacyQuery = legacyUserId
    ? `&legacy_user_id=${encodeURIComponent(legacyUserId)}`
    : '';
  return fetchDelete(
    `/skills/config/${encodeURIComponent(skillName)}?user_id=${encodeURIComponent(userId)}${legacyQuery}`,
    undefined,
    undefined,
    { signal: skillRequestSignal() }
  );
}

export async function skillConfigToggle(
  userId: string,
  skillName: string,
  enabled: boolean,
  legacyUserId?: string | null
): Promise<{ success: boolean; config?: Record<string, unknown> }> {
  const res = await fetchPost(
    `/skills/config/${encodeURIComponent(skillName)}/toggle`,
    {
      user_id: userId,
      enabled,
      ...(legacyUserId ? { legacy_user_id: legacyUserId } : {}),
    }
  );
  return res ?? { success: false };
}
