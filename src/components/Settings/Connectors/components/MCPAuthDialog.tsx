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

import { mcpOAuthStart, mcpOAuthStatus } from '@/api/brain';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Phase = 'idle' | 'starting' | 'waiting' | 'authorized' | 'error';

const POLL_INTERVAL_MS = 2000;
/** A human scanning a QR code needs minutes; a stuck flow must not need hours. */
const GIVE_UP_MS = 5 * 60 * 1000;

interface MCPAuthDialogProps {
  open: boolean;
  name: string;
  /** The MCP payload Brain should write once the token exists. */
  command: Record<string, unknown> | null;
  serverUrl: string;
  authorizationServer?: string;
  onClose: () => void;
  /** Called after Brain has stored the token, so the caller can finish the install. */
  onAuthorized: () => Promise<void> | void;
}

/**
 * A server that answers 401 with a protected-resource link does not want a
 * header, it wants a login. Asking the user to paste an API key for one of
 * those produces a value that is rejected no matter what they paste, so the
 * dialog offers the only action that can succeed: authorize in the browser.
 */
export const MCPAuthDialog: FC<MCPAuthDialogProps> = ({
  open,
  name,
  command,
  serverUrl,
  authorizationServer,
  onClose,
  onAuthorized,
}) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState('');
  /** Kept so the user can still reach the login page when the OS never opened it. */
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [browserOpened, setBrowserOpened] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadline = useRef(0);

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    if (open) {
      setPhase('idle');
      setDetail('');
      setAuthorizeUrl('');
      setBrowserOpened(true);
    }
    return stopPolling;
  }, [open, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const openInBrowser = async (url: string): Promise<boolean> => {
    const api = (window as any).electronAPI;
    if (api?.openExternal) {
      try {
        const result = await api.openExternal(url);
        // The IPC handler answers `{ success: false }` instead of throwing when
        // the OS refuses the URL, so "no exception" is not "it opened".
        if (result?.success !== false) return true;
      } catch {
        // Fall through to the window.open path below.
      }
    }
    try {
      return window.open(url, '_blank', 'noopener,noreferrer') !== null;
    } catch {
      return false;
    }
  };

  const poll = (state: string) => {
    stopPolling();
    deadline.current = Date.now() + GIVE_UP_MS;
    timer.current = setInterval(async () => {
      if (Date.now() > deadline.current) {
        stopPolling();
        setPhase('error');
        setDetail(t('connectors.auth-timeout'));
        return;
      }
      try {
        const result = await mcpOAuthStatus(state);
        if (result.status === 'authorized') {
          stopPolling();
          setPhase('authorized');
          await onAuthorized();
          return;
        }
        if (result.status === 'error' || result.status === 'unknown') {
          stopPolling();
          setPhase('error');
          setDetail(result.detail || t('connectors.auth-failed'));
        }
      } catch {
        // A single failed poll is not an answer; the next tick asks again.
      }
    }, POLL_INTERVAL_MS);
  };

  const handleAuthorize = async () => {
    if (!command || phase === 'starting' || phase === 'waiting') return;
    setPhase('starting');
    setDetail('');
    try {
      const started = await mcpOAuthStart(name, command);
      setAuthorizeUrl(started.authorize_url);
      // Brain opens the login page itself; only fall back to the renderer's
      // own attempts when it reports that the OS gave it no browser.
      const opened = started.browser_opened
        ? true
        : await openInBrowser(started.authorize_url);
      setBrowserOpened(opened);
      setPhase('waiting');
      poll(started.state);
    } catch (error: any) {
      setPhase('error');
      setDetail(error?.message || t('connectors.auth-failed'));
    }
  };

  const handleClose = () => {
    stopPolling();
    onClose();
  };

  // The user already expressed the intent by installing the connector, so the
  // dialog opens the browser itself instead of asking for a second click. The
  // ref keeps React's double-invoked effects from registering two clients.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!open) {
      autoStarted.current = false;
      return;
    }
    if (autoStarted.current || !command || phase !== 'idle') return;
    autoStarted.current = true;
    void handleAuthorize();
    // handleAuthorize closes over `poll`, which changes every render; the ref
    // above makes a second invocation a no-op, so it is not a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, command, phase]);

  const busy = phase === 'starting' || phase === 'waiting';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-flow would leave the user staring at a browser tab that
        // authorizes nothing. Let the button decide.
        if (!next && !busy) handleClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        size="sm"
        showCloseButton
        onClose={handleClose}
        onInteractOutside={(e: any) => {
          if (busy) e.preventDefault();
        }}
        onEscapeKeyDown={(e: any) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader
          title={t('connectors.auth-title', {
            name,
            defaultValue: '{{name}} 需要授权',
          })}
        />

        <div className="flex flex-col gap-3 p-md text-sm leading-normal text-ds-ink-default-default">
          <p>
            {t('connectors.auth-desc', {
              server: serverUrl,
              defaultValue:
                '{{server}} 要求先登录再连接：它拒绝匿名请求，并把授权地址指向 {{host}}。',
              host: authorizationServer || serverUrl,
            })}
          </p>
          {phase === 'waiting' && browserOpened && (
            <p className="text-ds-accent-default-default">
              {t('connectors.auth-waiting', {
                defaultValue: '浏览器已打开，完成登录后这里会自动继续……',
              })}
            </p>
          )}
          {phase === 'waiting' && authorizeUrl ? (
            // The OS never took the URL -- a sandboxed renderer, no default
            // browser, or a blocked popup. Claiming "the browser is open" in
            // that case sent the user looking for a window that does not exist,
            // so the link is always offered, and the raw URL too when nothing
            // opened. A click is also a user gesture, which is exactly what
            // `window.open` requires in a plain browser.
            <div className="flex flex-col gap-1">
              <a
                href={authorizeUrl}
                target="_blank"
                rel="noreferrer"
                className={`w-fit underline underline-offset-2 ${
                  browserOpened
                    ? 'text-ds-ink-muted-default'
                    : 'text-ds-accent-default-default'
                }`}
                onClick={(event) => {
                  event.preventDefault();
                  void openInBrowser(authorizeUrl).then(setBrowserOpened);
                }}
              >
                {t('connectors.auth-open', {
                  defaultValue: '在浏览器中授权',
                })}
              </a>
              {!browserOpened ? (
                <span className="break-all text-xs text-ds-ink-muted-default">
                  {authorizeUrl}
                </span>
              ) : null}
            </div>
          ) : null}
          {phase === 'authorized' && (
            <p className="text-ds-accent-default-default">
              {t('connectors.auth-done', { defaultValue: '授权成功。' })}
            </p>
          )}
          {phase === 'error' && detail && (
            <p className="text-ds-error-default-default">{detail}</p>
          )}
        </div>

        <DialogFooter
          className="!rounded-b-xl p-md"
          showCancelButton
          cancelButtonText={t('setting.cancel')}
          onCancel={handleClose}
          cancelButtonVariant="ghost"
          showConfirmButton
          confirmButtonText={
            busy
              ? t('connectors.auth-waiting-button', {
                  defaultValue: '等待授权…',
                })
              : phase === 'error'
                ? t('connectors.auth-retry', { defaultValue: '重新授权' })
                : t('connectors.auth-open', { defaultValue: '在浏览器中授权' })
          }
          onConfirm={handleAuthorize}
          confirmButtonVariant="primary"
          {...(busy ? ({ confirmButtonDisabled: true } as any) : {})}
        />
      </DialogContent>
    </Dialog>
  );
};
