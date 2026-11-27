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

import { proxyFetchGet } from '@/api/http';
import {
  AppCommandContext,
  type ExecuteAppCommand,
} from '@/components/Layout/AppCommandProvider';
import { UserMenu } from '@/components/TopBar/UserMenu';
import { APP_COMMAND } from '@/shared/appCommands';
import { setUsageAccount } from '@/store/usageNoticeStore';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/http', () => ({
  proxyFetchGet: vi.fn(),
}));

vi.mock('@/components/ui/icon-pill-toggle', () => ({
  IconPillToggle: ({
    options,
    value,
  }: {
    options: readonly { value: string; label: string }[];
    value: string;
  }) => (
    <div role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/hooks/useChatStoreAdapter', () => ({
  default: () => ({
    chatStore: { clearTasks: vi.fn() },
  }),
}));

vi.mock('@/store/authStore', () => {
  const authState = {
    email: 'person@example.com',
    username: 'Person',
    language: 'en',
    appearance: 'light' as const,
    appearanceMode: 'system',
    setAppearanceMode: vi.fn(),
    setLanguage: vi.fn(),
    logout: vi.fn(),
  };
  const useAuthStore = Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState }
  );

  return {
    getAuthStore: () => authState,
    useAuthStore,
  };
});

vi.mock('@/store/installationStore', () => {
  const installationState = {
    reset: vi.fn(),
    setNeedsBackendRestart: vi.fn(),
  };

  return {
    useInstallationStore: (
      selector: (state: typeof installationState) => unknown
    ) => selector(installationState),
  };
});

const executeAppCommand = vi.fn<ExecuteAppCommand>();

function renderUserMenu(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppCommandContext.Provider value={executeAppCommand}>
        <UserMenu />
      </AppCommandContext.Provider>
    </MemoryRouter>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', {
      name: 'Profile',
    })
  );
}

async function closeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
}

describe('UserMenu subscription summary', () => {
  let accountSequence = 0;

  beforeEach(() => {
    vi.mocked(proxyFetchGet).mockReset();
    executeAppCommand.mockReset();
    // refreshUsage() reads the active usage account; each test starts from a
    // clean account so no in-flight refresh is reused.
    accountSequence += 1;
    setUsageAccount(`user-menu-test-${accountSequence}`);
  });

  it('refreshes on each open and keeps credits when only the plan request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(proxyFetchGet)
      .mockResolvedValueOnce({ plan_key: 'pro' })
      .mockResolvedValueOnce({ credits: 10 })
      .mockResolvedValueOnce({ value: 'cloud-key' });

    renderUserMenu();
    await openMenu(user);

    await waitFor(() => {
      expect(proxyFetchGet).toHaveBeenCalledTimes(3);
    });
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Pro').parentElement).toHaveTextContent('Pro · 10');

    await closeMenu(user);
    vi.mocked(proxyFetchGet)
      .mockResolvedValueOnce({ plan_key: 'team' })
      .mockResolvedValueOnce({ credits: 20 })
      .mockResolvedValueOnce({ value: 'cloud-key' });
    await openMenu(user);

    await waitFor(() => {
      expect(proxyFetchGet).toHaveBeenCalledTimes(6);
      expect(screen.getByText('Team').parentElement).toHaveTextContent(
        'Team · 20'
      );
    });

    await closeMenu(user);
    vi.mocked(proxyFetchGet)
      .mockRejectedValueOnce(new Error('subscription unavailable'))
      .mockResolvedValueOnce({ credits: 25 })
      .mockResolvedValueOnce({ value: 'cloud-key' });
    await openMenu(user);

    await waitFor(() => {
      expect(proxyFetchGet).toHaveBeenCalledTimes(9);
      // The plan is unknown after the failed request, but the freshly read
      // credits still reach the row.
      expect(screen.getByText('—').parentElement).toHaveTextContent('— · 25');
    });
  });

  it('groups account details before preferences and dispatches Settings through the app command controller', async () => {
    const user = userEvent.setup();
    vi.mocked(proxyFetchGet)
      .mockResolvedValueOnce({ plan_key: 'pro' })
      .mockResolvedValueOnce({ credits: 10 });

    renderUserMenu('/?tab=project');
    await openMenu(user);

    const menu = screen.getByRole('menu');
    const email = within(menu).getByText('person@example.com');
    const plan = within(menu).getByText('Pro').parentElement;
    const [accountDivider, logoutDivider] =
      within(menu).getAllByRole('separator');
    const appearance = within(menu).getByText('Appearance');
    const language = within(menu).getByRole('menuitem', { name: 'Language' });
    const settings = within(menu).getByRole('menuitem', { name: 'Settings' });
    const logout = within(menu).getByRole('menuitem', { name: 'Log out' });

    expect(plan).toHaveTextContent('Pro · 10');
    expect(settings.querySelector('svg')).toHaveClass('lucide-settings');
    for (const [current, next] of [
      [email, plan],
      [plan, accountDivider],
      [accountDivider, appearance],
      [appearance, language],
      [language, settings],
      [settings, logoutDivider],
      [logoutDivider, logout],
    ] as const) {
      expect(
        current?.compareDocumentPosition(next) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }

    // Refer friends and Keyboard Shortcuts are no longer part of the menu.
    expect(
      within(menu).queryByRole('menuitem', { name: 'Refer friends' })
    ).toBeNull();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Keyboard Shortcuts' })
    ).toBeNull();

    // Appearance keeps only the explicit light and dark choices.
    const modes = within(menu).getAllByRole('radio');
    expect(modes.map((mode) => mode.getAttribute('aria-label'))).toEqual([
      'Light',
      'Dark',
    ]);
    // A stored "system" preference surfaces as the mode it resolved to.
    expect(within(menu).getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await user.click(settings);

    expect(executeAppCommand).toHaveBeenCalledWith(APP_COMMAND.openSettings);
  });
});
