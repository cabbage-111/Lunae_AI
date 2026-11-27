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

import { fetchGet, fetchPut } from '@/api/http';

export type PermissionProfileName =
  'read_only' | 'request_approval' | 'auto_reviewer' | 'full_access';

export interface SpacePermissionProfile {
  space_id: string;
  profile_name: PermissionProfileName;
  sandbox_mode: string;
  approval_mode: string;
  reviewer_mode: string;
  revision: number;
  updated_by: string;
  created_at: number | null;
  updated_at: number | null;
}

const profileCache = new Map<string, SpacePermissionProfile>();
const profileRequests = new Map<string, Promise<SpacePermissionProfile>>();
const profileFailures = new Map<
  string,
  { error: unknown; retryAfter: number }
>();
const PROFILE_FAILURE_BACKOFF_MS = 3_000;

export const getSpacePermissionProfile = (
  spaceId: string,
  options: { refresh?: boolean } = {}
): Promise<SpacePermissionProfile> => {
  // A refresh bypasses a successful value, but never an in-flight request or
  // the short failure backoff. This keeps remounting views from turning one
  // unavailable local Brain into an unbounded request loop.
  const pending = profileRequests.get(spaceId);
  if (pending) return pending;

  if (!options.refresh) {
    const cached = profileCache.get(spaceId);
    if (cached) return Promise.resolve(cached);
  }

  const failure = profileFailures.get(spaceId);
  if (failure && failure.retryAfter > Date.now()) {
    return Promise.reject(failure.error);
  }
  profileFailures.delete(spaceId);

  const request = fetchGet(
    `/spaces/${encodeURIComponent(spaceId)}/permission-profile`
  )
    .then((profile: SpacePermissionProfile) => {
      profileCache.set(spaceId, profile);
      profileFailures.delete(spaceId);
      return profile;
    })
    .catch((error: unknown) => {
      profileFailures.set(spaceId, {
        error,
        retryAfter: Date.now() + PROFILE_FAILURE_BACKOFF_MS,
      });
      throw error;
    })
    .finally(() => profileRequests.delete(spaceId));
  profileRequests.set(spaceId, request);
  return request;
};

export const putSpacePermissionProfile = (
  spaceId: string,
  input: {
    profileName: PermissionProfileName;
    requestId: string;
    updatedBy: string;
    expectedRevision: number;
  }
): Promise<SpacePermissionProfile> =>
  fetchPut(`/spaces/${encodeURIComponent(spaceId)}/permission-profile`, {
    profile_name: input.profileName,
    request_id: input.requestId,
    updated_by: input.updatedBy,
    expected_revision: input.expectedRevision,
  }).then((profile: SpacePermissionProfile) => {
    profileCache.set(spaceId, profile);
    profileFailures.delete(spaceId);
    return profile;
  });

/**
 * True when the Brain refused the call at its local-control auth boundary
 * rather than failing to serve the profile.
 *
 * A Brain started outside Electron has no Desktop capability and, under
 * `NoneAuth`, answers 503 `local_control_auth_unconfigured`. When it runs with
 * the browser auth provider but the page was never paired, it answers 401
 * `brain_auth_required_for_control`. Treat both (and the 401 for a capability
 * that does not match) as "control APIs unavailable in this environment" so the
 * caller can degrade instead of reporting a load failure the user cannot act on.
 */
export const isLocalControlUnavailableError = (error: unknown): boolean => {
  const failure = error as
    | {
        status?: number;
        response?: { data?: { detail?: { code?: string } } };
      }
    | null
    | undefined;
  const status = failure?.status;
  const code = failure?.response?.data?.detail?.code;
  return (
    (status === 503 && code === 'local_control_auth_unconfigured') ||
    (status === 401 && code === 'local_control_capability_required') ||
    // A browser tab authenticates with a paired token instead of a Desktop
    // capability. Missing or expired pairing lands here, which is the same
    // "control APIs unavailable in this environment" condition: the picker
    // degrades and the caller explains how to pair.
    (status === 401 && code === 'brain_auth_required_for_control')
  );
};

export const __permissionProfileApiTestHooks = {
  reset() {
    profileCache.clear();
    profileRequests.clear();
    profileFailures.clear();
  },
  failureBackoffMs: PROFILE_FAILURE_BACKOFF_MS,
};
