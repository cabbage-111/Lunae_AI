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

import lunaeIcon from '@/assets/logo/lunae_icon.png';
import { cn } from '@/lib/utils';

/**
 * The LunaeAI app mark: a black tile with the white mark, so it reads the same
 * in light and dark mode. Decorative; callers give it a size.
 */
export function LunaeAppIcon({ className }: { className?: string }) {
  return (
    <img
      src={lunaeIcon}
      alt=""
      aria-hidden
      draggable={false}
      data-lunae-app-icon
      className={cn('shrink-0 select-none', className)}
    />
  );
}
