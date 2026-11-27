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

import { afterEach, describe, expect, it, vi } from 'vitest';

const openSettings = vi.hoisted(() => vi.fn());

vi.mock('@/store/settingsStore', () => ({ openSettings }));

import { openPricing } from '@/lib/creditRecovery';

describe('openPricing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('opens model settings instead of the cloud pricing page in a local build', () => {
    vi.stubEnv('VITE_USE_LOCAL_PROXY', 'true');

    openPricing();

    expect(openSettings).toHaveBeenCalledWith('models');
  });

  it('leaves model settings alone when the cloud backend is in use', () => {
    vi.stubEnv('VITE_USE_LOCAL_PROXY', 'false');

    openPricing();

    expect(openSettings).not.toHaveBeenCalled();
  });
});
