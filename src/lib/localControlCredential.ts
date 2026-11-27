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
 * Browser counterpart of the Electron control capability.
 *
 * The packaged Desktop renderer asks the main process for a per-launch
 * capability. A browser tab has no IPC, so it holds a signed, expiring token
 * instead: the Brain prints one at startup and the page stores it locally.
 * Both are sent to the Brain as a header and checked by the same dependency.
 *
 * The token is kept in localStorage rather than in a cookie so it is bound to
 * this origin only and is never attached to third-party requests.
 */

const STORAGE_KEY = 'eigent.local-control-token';
const QUERY_PARAM = 'localControlToken';
/** Token version prefix issued by `app/auth/local_browser.py`. */
const TOKEN_PREFIX = 'lc1.';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Token published by the dev server when the Brain runs with
 * `EIGENT_LOCAL_BROWSER_AUTOPAIR=1`. Only `vite.config.web.ts` (dev) injects
 * it, so a production build can never carry one.
 */
function autopairedToken(): string {
  if (typeof window === 'undefined') return '';
  const injected = (
    window as unknown as { __EIGENT_LOCAL_CONTROL_TOKEN__?: unknown }
  ).__EIGENT_LOCAL_CONTROL_TOKEN__;
  return typeof injected === 'string' ? injected.trim() : '';
}

export function getLocalControlToken(): string {
  try {
    const stored = storage()?.getItem(STORAGE_KEY)?.trim() ?? '';
    if (stored) return stored;
  } catch {
    // Fall through to the dev-injected token.
  }
  const injected = autopairedToken();
  return injected.startsWith(TOKEN_PREFIX) ? injected : '';
}

export function setLocalControlToken(token: string): void {
  const value = token.trim();
  if (!value.startsWith(TOKEN_PREFIX)) return;
  try {
    storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Private-mode storage failures only cost the user a re-pairing.
  }
}

export function clearLocalControlToken(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

function readQueryToken(): { token: string; fromHash: boolean } | null {
  const search = new URLSearchParams(window.location.search);
  const fromSearch = search.get(QUERY_PARAM)?.trim();
  if (fromSearch) return { token: fromSearch, fromHash: false };

  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  const fromHash = new URLSearchParams(hash.slice(queryIndex + 1))
    .get(QUERY_PARAM)
    ?.trim();
  return fromHash ? { token: fromHash, fromHash: true } : null;
}

function stripQueryToken(fromHash: boolean): void {
  if (fromHash) {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    const query = new URLSearchParams(hash.slice(queryIndex + 1));
    query.delete(QUERY_PARAM);
    const rest = query.toString();
    const nextHash = rest ? `${route}?${rest}` : route;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${nextHash}`
    );
    return;
  }
  const query = new URLSearchParams(window.location.search);
  query.delete(QUERY_PARAM);
  const rest = query.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`
  );
}

/**
 * Move a `?localControlToken=` value from the address bar into storage.
 *
 * Runs once at startup: the token is stored, then removed from the URL and
 * from history so it does not linger in the address bar or a shared link.
 */
export function captureLocalControlTokenFromLocation(): boolean {
  try {
    const found = readQueryToken();
    if (!found) return false;
    setLocalControlToken(found.token);
    stripQueryToken(found.fromHash);
    return getLocalControlToken() === found.token.trim();
  } catch {
    return false;
  }
}
