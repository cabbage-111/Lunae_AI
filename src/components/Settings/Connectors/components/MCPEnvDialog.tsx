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

import githubIcon from '@/assets/icon/github.svg';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog';
import { DsIcon } from '@/components/ui/ds-icon';
import { Input } from '@/components/ui/input';
import { Bot, Eye, EyeOff } from 'lucide-react';
import { FC, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface EnvValue {
  value: string;
  required: boolean;
  tip: string;
  error?: string;
}

interface MCPEnvDialogProps {
  showEnvConfig: boolean;
  onClose: () => void;
  onConnect: (mcp: any) => void;
  activeMcp?: any;
}

export async function google_check(apiKey: string, searchEngineId: string) {
  const query = 'hello'; // rand word
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(
    query
  )}&num=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Google API error: ${res.status}`);
    }
    const data = await res.json();

    if ('items' in data) {
      return {
        success: true,
        sample: data.items[0],
      };
    }
    return { success: false, error: data.error };
  } catch (err: any) {
    return { success: false, error: err };
  }
}

export async function exa_check(apiKey: string) {
  const query = 'hello'; // rand search word

  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(`Exa API error: ${res.status} ${data.error}`);
    }

    const data = await res.json();
    if ('results' in data) {
      return {
        success: true,
        sample: data.results[0],
      };
    }
    return { success: false, error: data };
  } catch (err: any) {
    return { success: false, error: err };
  }
}

export const MCPEnvDialog: FC<MCPEnvDialogProps> = ({
  showEnvConfig,
  onClose,
  onConnect,
  activeMcp,
}) => {
  const [envValues, setEnvValues] = useState<{ [key: string]: EnvValue }>({});
  const [headerValues, setHeaderValues] = useState<{
    [key: string]: EnvValue;
  }>({});
  const [showKeys, setShowKeys] = useState<{ [key: string]: boolean }>({});
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (activeMcp?.install_command?.env) {
      const initialValues: { [key: string]: EnvValue } = {};
      Object.keys(activeMcp.install_command.env).forEach((key) => {
        initialValues[key] = {
          value: '',
          required: true,
          tip:
            activeMcp.install_command?.env?.[key]
              ?.replace(/{{/g, '')
              ?.replace(/}}/g, '') || '',
        };
        if (key === 'EXA_API_KEY') {
          initialValues[key].required = false;
        }
        if (key === 'GOOGLE_REFRESH_TOKEN') {
          initialValues[key].required = false;
        }
      });
      setEnvValues(initialValues);
    }

    // A remote server behind an API key needs a header, and a header with no
    // value is a 401 with no explanation. Ask for it here, the same way env is
    // asked for, instead of installing with the catalogue placeholder.
    if (activeMcp?.install_command?.headers) {
      const initialHeaders: { [key: string]: EnvValue } = {};
      Object.keys(activeMcp.install_command.headers).forEach((key) => {
        initialHeaders[key] = {
          value: '',
          required: true,
          tip:
            activeMcp.install_command?.headers?.[key]
              ?.replace(/{{/g, '')
              ?.replace(/}}/g, '') || '',
        };
      });
      setHeaderValues(initialHeaders);
    }
  }, [activeMcp]);

  const getCategoryIcon = (categoryName?: string) => {
    if (!categoryName)
      return (
        <DsIcon
          icon={Bot}
          recipe="illustration"
          illustrationSize={40}
          className="text-ds-ink-default-default"
        />
      );
    return (
      <DsIcon
        icon={Bot}
        recipe="illustration"
        illustrationSize={40}
        className="text-ds-ink-default-default"
      />
    );
  };

  const getGithubRepoName = (homePage?: string) => {
    if (!homePage || !homePage.startsWith('https://github.com/')) return null;
    const parts = homePage.split('/');
    return parts.length > 4 ? parts[4] : homePage;
  };
  const updateEnvValue = (key: string, value: string) => {
    setEnvValues((prev) => ({
      ...prev,
      [key]: {
        value,
        required: prev[key]?.required || true,
        tip: prev[key]?.tip || '',
      },
    }));
  };
  const updateHeaderValue = (key: string, value: string) => {
    setHeaderValues((prev) => ({
      ...prev,
      [key]: {
        value,
        required: prev[key]?.required || true,
        tip: prev[key]?.tip || '',
      },
    }));
  };
  const handleCloseMcpEnvSetting = () => {
    setEnvValues({});
    setHeaderValues({});
    setShowKeys({});
    onClose();
  };

  const setFieldError = (key: string, error: string) => {
    setEnvValues((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        error,
      },
    }));
  };

  const clearFieldErrors = () => {
    const cleared = (prev: { [key: string]: EnvValue }) => {
      const updated: { [key: string]: EnvValue } = {};
      Object.keys(prev).forEach((key) => {
        updated[key] = { ...prev[key], error: '' };
      });
      return updated;
    };
    setEnvValues(cleared);
    setHeaderValues(cleared);
  };

  const validateRequiredFields = () => {
    let hasErrors = false;

    const check = (
      values: { [key: string]: EnvValue },
      setter: (next: { [key: string]: EnvValue }) => void
    ) => {
      const updated = { ...values };
      Object.keys(values).forEach((key) => {
        const field = values[key];
        if (field?.required && (!field.value || field.value.trim() === '')) {
          updated[key] = {
            ...field,
            error: t('connectors.field-required', {
              field: getTitleContent(key),
            }),
          };
          hasErrors = true;
        }
      });
      setter(updated);
    };

    check(envValues, setEnvValues);
    check(headerValues, setHeaderValues);

    return !hasErrors;
  };

  const getTitleContent = (key: string) => {
    if (key === 'SEARCH_ENGINE_ID') {
      return t('connectors.search-engine-id');
    } else if (key === 'GOOGLE_API_KEY') {
      return t('connectors.google-api-key');
    } else if (key === 'EXA_API_KEY') {
      return t('connectors.exa-api-key');
    }
    return key;
  };

  const handleConfigureMcpEnvSetting = async () => {
    if (isValidating) return;

    setIsValidating(true);
    clearFieldErrors();

    // Validate required fields first
    if (!validateRequiredFields()) {
      setIsValidating(false);
      return;
    }

    const env: { [key: string]: string } = {};
    Object.keys(envValues).forEach((key) => {
      env[key] = envValues[key]?.value;
    });

    const headers: { [key: string]: string } = {};
    Object.keys(headerValues).forEach((key) => {
      headers[key] = headerValues[key]?.value;
    });

    // Validate Google API key
    if (env['GOOGLE_API_KEY'] && env['SEARCH_ENGINE_ID']) {
      const result = await google_check(
        env['GOOGLE_API_KEY'],
        env['SEARCH_ENGINE_ID']
      );
      if (!result.success) {
        const errorMessage = t('connectors.google-check-failed');
        setFieldError('GOOGLE_API_KEY', errorMessage);
        setFieldError('SEARCH_ENGINE_ID', errorMessage);
        setIsValidating(false);
        return;
      }
    }

    // Validate Exa API key
    if (env['EXA_API_KEY']) {
      const result = await exa_check(env['EXA_API_KEY']);
      if (!result.success) {
        setFieldError('EXA_API_KEY', t('connectors.exa-check-failed'));
        setIsValidating(false);
        return;
      }
    }

    // Save only if all validations succeed
    const mcp = {
      ...activeMcp,
      install_command: {
        ...activeMcp.install_command,
        env,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
    try {
      // Keep the dialog in validating state until onConnect completes
      await onConnect(mcp);
      // Only clear values after successful completion
      setEnvValues({});
      setHeaderValues({});
      setShowKeys({});
    } finally {
      setIsValidating(false);
    }
  };
  return (
    <Dialog
      open={showEnvConfig}
      onOpenChange={(open) => {
        // If validating, ignore close intents from Radix (e.g., Confirm wraps Close internally)
        if (!open) {
          if (isValidating) return;
          handleCloseMcpEnvSetting();
        }
      }}
    >
      <form>
        <DialogContent
          aria-describedby={undefined}
          size="sm"
          showCloseButton
          onClose={handleCloseMcpEnvSetting}
          // Prevent closing while validating (OAuth in progress)
          onInteractOutside={(e: any) => {
            if (isValidating) e.preventDefault();
          }}
          onEscapeKeyDown={(e: any) => {
            if (isValidating) e.preventDefault();
          }}
          onPointerDownOutside={(e: any) => {
            if (isValidating) e.preventDefault();
          }}
        >
          <DialogHeader
            title={t('setting.configure {name} Toolkit', {
              name: activeMcp?.name,
            })}
          />

          <div className="flex flex-col gap-3 p-md">
            <div className="flex items-center gap-md">
              {getCategoryIcon(activeMcp?.category?.name)}
              <div>
                <span className="block text-base leading-9 font-bold text-ds-accent-default-default">
                  {activeMcp?.name}
                </span>
                <div className="text-sm leading-normal font-bold text-ds-ink-default-default">
                  {getGithubRepoName(activeMcp?.home_page) && (
                    <div className="flex items-center">
                      <img
                        src={githubIcon}
                        alt=""
                        style={{
                          width: 14.7,
                          height: 14.7,
                          marginRight: 4,
                          display: 'inline-block',
                          verticalAlign: 'middle',
                        }}
                      />
                      <span className="line-clamp-1 items-center justify-center self-stretch overflow-hidden text-xs leading-normal font-medium break-words text-ellipsis">
                        {getGithubRepoName(activeMcp?.home_page)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-md">
              {Object.keys(activeMcp?.install_command?.env || {}).map((key) => {
                const getNoteContent = () => {
                  let noteContent = envValues[key]?.tip || '';

                  if (key === 'SEARCH_ENGINE_ID') {
                    noteContent += ` ${t('setting.get-it-from')}: https://developers.google.com/custom-search/v1/overview`;
                  } else if (key === 'GOOGLE_API_KEY') {
                    noteContent += ` ${t('setting.get-it-from')}: https://console.cloud.google.com/apis/credentials`;
                  } else if (key === 'EXA_API_KEY') {
                    noteContent += ` ${t('setting.get-it-from')}: https://exa.ai (${t('connectors.optional')})`;
                  }

                  return noteContent;
                };

                return (
                  <Input
                    key={key}
                    size="default"
                    title={getTitleContent(key)}
                    note={getNoteContent()}
                    required={envValues[key]?.required || false}
                    state={envValues[key]?.error ? 'error' : 'default'}
                    type={showKeys[key] ? 'text' : 'password'}
                    placeholder={t('connectors.enter-field', {
                      field: getTitleContent(key),
                    })}
                    value={envValues[key]?.value || ''}
                    backIcon={
                      showKeys[key] ? (
                        <DsIcon icon={Eye} />
                      ) : (
                        <DsIcon icon={EyeOff} />
                      )
                    }
                    onBackIconClick={() =>
                      setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }))
                    }
                    onChange={(e) => updateEnvValue(key, e.target.value)}
                  />
                );
              })}
              {Object.keys(activeMcp?.install_command?.headers || {}).map(
                (key) => {
                  const toggle = `header:${key}`;
                  return (
                    <Input
                      key={toggle}
                      size="default"
                      title={key}
                      note={headerValues[key]?.tip || ''}
                      required={headerValues[key]?.required || false}
                      state={headerValues[key]?.error ? 'error' : 'default'}
                      type={showKeys[toggle] ? 'text' : 'password'}
                      placeholder={t('connectors.enter-field', { field: key })}
                      value={headerValues[key]?.value || ''}
                      backIcon={
                        showKeys[toggle] ? (
                          <DsIcon icon={Eye} />
                        ) : (
                          <DsIcon icon={EyeOff} />
                        )
                      }
                      onBackIconClick={() =>
                        setShowKeys((prev) => ({
                          ...prev,
                          [toggle]: !prev[toggle],
                        }))
                      }
                      onChange={(e) => updateHeaderValue(key, e.target.value)}
                    />
                  );
                }
              )}
            </div>
          </div>
          <DialogFooter
            className="!rounded-b-xl p-md"
            showCancelButton
            cancelButtonText={t('setting.cancel')}
            onCancel={handleCloseMcpEnvSetting}
            cancelButtonVariant="ghost"
            showConfirmButton
            confirmButtonText={
              isValidating ? t('setting.verifying') : t('setting.connect')
            }
            onConfirm={handleConfigureMcpEnvSetting}
            confirmButtonVariant="primary"
            // Optional: consumers of DialogFooter may support disabled prop
            {...(isValidating ? ({ confirmButtonDisabled: true } as any) : {})}
          />
        </DialogContent>
      </form>
    </Dialog>
  );
};
