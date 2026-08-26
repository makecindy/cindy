// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

import { ForgeOidcInstallConfirmHost } from '../ForgeOidcInstallConfirmHost';
import enCommon from '../../i18n/locales/en/common.json';
import jaCommon from '../../i18n/locales/ja/common.json';
import koCommon from '../../i18n/locales/ko/common.json';
import zhCNCommon from '../../i18n/locales/zh-CN/common.json';
import zhTWCommon from '../../i18n/locales/zh-TW/common.json';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('react-i18next', () => ({
  Trans: () => null,
  useTranslation: () => ({
    t: (key: string, options?: { id?: string }) => (options?.id ? `${key}:${options.id}` : key),
  }),
}));

describe('ForgeOidcInstallConfirmHost', () => {
  let push:
    | ((payload: {
        requestId: string;
        ghostId: string;
        ghostName: string;
        hosts: string[];
      }) => void)
    | undefined;
  const resolveConfirm = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset().mockResolvedValue(true);
    resolveConfirm.mockReset().mockResolvedValue({ handled: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghosts: {
        onForgeOidcInstallConfirmRequest: (callback: typeof push) => {
          push = callback;
          return () => {};
        },
        resolveForgeOidcInstallConfirm: resolveConfirm,
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('passes exact typed-id and selectable facts without adding a copy action', async () => {
    render(<ForgeOidcInstallConfirmHost />);
    await act(async () => {
      push?.({
        requestId: 'request-1',
        ghostId: 'acme-tool',
        ghostName: 'Acme Tool',
        hosts: ['api.acme.test', 'files.acme.test'],
      });
    });

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const options = mocks.confirm.mock.calls[0][0] as {
      content: ReactNode;
      contentSelectable: boolean;
      requireTypedConfirmation: { expected: string; label: ReactNode };
    };
    expect(options.contentSelectable).toBe(true);
    expect(options.requireTypedConfirmation.expected).toBe('acme-tool');
    const label = options.requireTypedConfirmation.label as ReactElement<{
      i18nKey: string;
      values: { id: string };
      components: { strong: ReactElement<{ className?: string }> };
    }>;
    expect(label.props.i18nKey).toBe('settings.ghosts.forgeOidcInstallConfirm.typedIdLabel');
    expect(label.props.values).toEqual({ id: 'acme-tool' });
    expect(label.props.components.strong.type).toBe('strong');
    expect(label.props.components.strong.props.className).toContain('font-semibold');

    render(<>{options.content}</>);
    expect(screen.getByText('Acme Tool')).toBeTruthy();
    expect(screen.getByText('acme-tool')).toBeTruthy();
    expect(screen.getByText('api.acme.test')).toBeTruthy();
    expect(screen.getByText('files.acme.test')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(resolveConfirm).toHaveBeenCalledWith('request-1', true);
  });

  it.each([
    ['zh-CN', zhCNCommon],
    ['zh-TW', zhTWCommon],
    ['en', enCommon],
    ['ja', jaCommon],
    ['ko', koCommon],
  ])('%s 的手输提示用加粗 id 且不再用引号包裹', (_locale, common) => {
    const label = common.settings.ghosts.forgeOidcInstallConfirm.typedIdLabel;
    // 直接读每个 locale，排除缺 key 后被英文 fallback 掩盖。
    expect(label).toContain(' <strong>{{id}}</strong> ');
    expect(label).not.toMatch(/[“”「」]/);
  });
});
