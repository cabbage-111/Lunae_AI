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
 * Approval-mode picker for the chat input bar — same pill-trigger shell as
 * `ModelAndThinkingEffortSelect` / `ProjectModeToggle` so the
 * controls read as one family in the `BoxFooter` row.
 *
 * A Space-level permission-profile picker. Changes apply to future Runs;
 * active RunAttempts keep their immutable admission-time profile revision.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DsIcon } from '@/components/ui/ds-icon';
import { generateUniqueId } from '@/lib';
import { cn } from '@/lib/utils';
import {
  getSpacePermissionProfile,
  isLocalControlUnavailableError,
  PermissionProfileName,
  putSpacePermissionProfile,
} from '@/service/permissionProfileApi';
import { useAuthStore } from '@/store/authStore';
import {
  Check,
  ChevronDown,
  Eye,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FOOTER_COMPACT_TRIGGER_CLASS } from './footerCompact';

interface ApprovalOption {
  value: PermissionProfileName;
  label: string;
  description: string;
  icon: typeof ShieldCheck;
}

const MENU_CONTENT_WIDTH_CLASS = 'w-[280px]';

/**
 * Load failures already reported, keyed by space and kind. The Brain answers
 * every control call the same way until it is restarted, so remounting the
 * footer must not replay the same diagnostic on each mount.
 */
const reportedLoadFailures = new Set<string>();

const triggerShellClass = cn(
  'rounded-xl px-2 py-1 inline-flex max-w-[min(100%,320px)] shrink-0 items-center gap-1.5',
  'bg-ds-neutral-subtle-default text-ds-ink-default-default'
);

export interface ApprovalModeSelectProps {
  spaceId?: string | null;
  disabled?: boolean;
  /** Shows the current mode in the same read-only shell as the model/mode controls. */
  readOnly?: boolean;
  /** When true, shows only the mode icon: no label, no chevron (narrow footer). */
  compact?: boolean;
  className?: string;
}

export function ApprovalModeSelect({
  spaceId,
  disabled,
  readOnly = false,
  compact = false,
  className,
}: ApprovalModeSelectProps) {
  const { t } = useTranslation();
  const approvalOptions: ApprovalOption[] = [
    {
      value: 'read_only',
      label: t('chat.approval-mode-read-only', { defaultValue: 'Read only' }),
      description: t('chat.approval-mode-read-only-description', {
        defaultValue: 'LunaeAI can read your files but cannot change anything.',
      }),
      icon: Eye,
    },
    {
      value: 'request_approval',
      label: t('chat.approval-mode-ask-first', {
        defaultValue: 'Ask me first',
      }),
      description: t('chat.approval-mode-ask-first-description', {
        defaultValue:
          'LunaeAI asks for your approval before it changes anything.',
      }),
      icon: ShieldQuestion,
    },
    {
      value: 'auto_reviewer',
      label: t('chat.approval-mode-approve-for-me', {
        defaultValue: 'Approve for me',
      }),
      description: t('chat.approval-mode-approve-for-me-description', {
        defaultValue:
          'LunaeAI approves routine steps and only asks about risky ones.',
      }),
      icon: ShieldCheck,
    },
    {
      value: 'full_access',
      label: t('chat.approval-mode-full-access', {
        defaultValue: 'Full access',
      }),
      description: t('chat.approval-mode-full-access-description', {
        defaultValue: 'LunaeAI acts without asking. Use with care.',
      }),
      icon: TriangleAlert,
    },
  ];
  const userId = useAuthStore((state) => state.user_id);
  const [value, setValue] = useState<PermissionProfileName>('request_approval');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  /** Set when this Brain refuses the profile at its local-control boundary. */
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!spaceId) {
      setValue('request_approval');
      setRevision(0);
      setUnavailable(false);
      return;
    }
    setLoading(true);
    void getSpacePermissionProfile(spaceId)
      .then((profile) => {
        if (cancelled) return;
        setValue(profile.profile_name);
        setRevision(profile.revision);
        setUnavailable(false);
        reportedLoadFailures.delete(`${spaceId}:unavailable`);
        reportedLoadFailures.delete(`${spaceId}:error`);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A Brain started outside Desktop (standalone `dev:web` loop) has no
        // control-capability boundary, so this profile can never load there.
        // Degrade the picker to read-only and surface the misconfiguration
        // once, instead of failing the same request on every remount.
        if (isLocalControlUnavailableError(error)) {
          setUnavailable(true);
          const key = `${spaceId}:unavailable`;
          if (!reportedLoadFailures.has(key)) {
            reportedLoadFailures.add(key);
            if (import.meta.env.DEV) {
              console.warn(
                `[ApprovalModeSelect] Control APIs are not authenticated on this Brain (space ${spaceId}). ` +
                  'Pair the web UI by opening the link printed in the Brain startup log once ' +
                  '(<origin>/?localControlToken=lc1....), or start the Brain with ' +
                  'EIGENT_LOCAL_CONTROL_CAPABILITY set to the same value as VITE_LOCAL_CONTROL_CAPABILITY.'
              );
            } else {
              toast.error(
                t('chat.approval-mode-load-failed', {
                  defaultValue: "Couldn't load the approval mode.",
                })
              );
            }
          }
          return;
        }
        const key = `${spaceId}:error`;
        if (reportedLoadFailures.has(key)) return;
        reportedLoadFailures.add(key);
        toast.error(
          t('chat.approval-mode-load-failed', {
            defaultValue: "Couldn't load the approval mode.",
          })
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, t]);

  const updateProfile = async (next: PermissionProfileName) => {
    if (!spaceId || next === value) return;
    if (
      next === 'full_access' &&
      !window.confirm(
        t('chat.approval-mode-full-access-confirmation', {
          defaultValue:
            'Full access lets LunaeAI act without asking you first, including actions that change files or send messages. Continue?',
        })
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      const updated = await putSpacePermissionProfile(spaceId, {
        profileName: next,
        requestId: generateUniqueId(),
        updatedBy: String(userId ?? 'local-user'),
        expectedRevision: revision,
      });
      setValue(updated.profile_name);
      setRevision(updated.revision);
      toast.success(
        t('chat.approval-mode-updated', {
          defaultValue: 'Approval mode updated. It applies to new tasks.',
        })
      );
    } catch {
      toast.error(
        t('chat.approval-mode-update-failed', {
          defaultValue: "Couldn't update the approval mode. Try again.",
        })
      );
      try {
        const current = await getSpacePermissionProfile(spaceId, {
          refresh: true,
        });
        setValue(current.profile_name);
        setRevision(current.revision);
      } catch {
        // Keep the last known profile; the next Space change retries loading.
      }
    } finally {
      setLoading(false);
    }
  };

  const current =
    approvalOptions.find((o) => o.value === value) ?? approvalOptions[0];
  const CurrentIcon = current.icon;
  /** Names the control as well as its value, so the label stands alone. */
  const accessibleLabel = t('chat.approval-mode-current', {
    value: current.label,
    defaultValue: 'Approval mode: {{value}}',
  });
  /** The trigger explains a read-only degrade without adding a new state. */
  const unavailableLabel = t('chat.approval-mode-load-failed', {
    defaultValue: "Couldn't load the approval mode.",
  });

  if (readOnly) {
    return (
      <div
        role="status"
        title={unavailable ? unavailableLabel : current.label}
        aria-label={accessibleLabel}
        className={cn(
          triggerShellClass,
          'pointer-events-none bg-transparent',
          { 'opacity-50': disabled || loading || unavailable },
          compact && FOOTER_COMPACT_TRIGGER_CLASS,
          className
        )}
      >
        <span className="inline-flex min-h-[1.25rem] min-w-0 items-center gap-1.5 overflow-hidden">
          <DsIcon icon={CurrentIcon} className="opacity-80" />
          {!compact && (
            <span className="min-w-0 truncate !text-ds-text-meta font-semibold">
              {current.label}
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading || !spaceId || unavailable}
          title={unavailable ? unavailableLabel : current.label}
          aria-label={accessibleLabel}
          aria-haspopup="menu"
          className={cn(
            triggerShellClass,
            'min-w-0 cursor-pointer border-0 border-x-0 border-y-0 text-left',
            'justify-between font-semibold transition-colors',
            'hover:bg-ds-neutral-default-default active:shadow-ds-elevation-control-pressed data-[state=open]:bg-ds-neutral-default-default',
            'focus-visible:ring-2 focus-visible:ring-ds-hairline-strong-default focus-visible:ring-offset-2 focus-visible:ring-offset-ds-neutral-subtle-default focus-visible:outline-none',
            'disabled:pointer-events-none disabled:opacity-50',
            compact && FOOTER_COMPACT_TRIGGER_CLASS,
            className
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <DsIcon icon={CurrentIcon} className="opacity-80" />
            {!compact && (
              <span className="min-w-0 flex-1 truncate text-left !text-ds-text-meta text-ds-ink-default-default">
                {current.label}
              </span>
            )}
          </span>
          {!compact && <DsIcon icon={ChevronDown} className="opacity-80" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={4}
        collisionPadding={12}
        avoidCollisions
        className={MENU_CONTENT_WIDTH_CLASS}
      >
        {approvalOptions.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => void updateProfile(option.value)}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex min-w-0 items-start gap-2">
                <DsIcon icon={OptionIcon} className="opacity-80" />
                <span className="min-w-0">
                  <span className="block text-ds-text-base">
                    {option.label}
                  </span>
                  <span className="block text-xs text-ds-ink-subtle-default">
                    {option.description}
                  </span>
                </span>
              </span>
              {value === option.value && (
                <DsIcon
                  icon={Check}
                  className="text-ds-text-success-default-default"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
