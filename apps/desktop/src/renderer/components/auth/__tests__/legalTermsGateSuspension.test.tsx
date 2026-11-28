// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 协议更新确认期间,自动弹出的全局弹窗必须暂缓。依据:Radix 模态打开后会抢焦点并禁用页面其余
 * 部分的指针事件,却画在协议遮罩下面,用户看得到「同意」却点不了。以飞书冲突提示为代表验证
 * 「事件照常接收、确认期间不显示、确认后再弹出」;其余宿主共用同一个 useLegalTermsGateBlocking。
 */

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { FeishuConflictDialogHost } from '../../feishuBot/FeishuConflictDialogHost';
import { setLegalTermsGateBlocking } from '../legalTermsGateState';

let emitConflict: ((payload: { appId: string }) => void) | null = null;

beforeEach(() => {
  Object.assign(window, {
    electronAPI: {
      feishuBot: {
        onConflict: (cb: (payload: { appId: string }) => void) => {
          emitConflict = cb;
          return () => {
            emitConflict = null;
          };
        },
        getState: async () => ({ service: 'feishu' }),
      },
      openExternal: vi.fn(),
    },
  });
});

afterEach(() => {
  act(() => setLegalTermsGateBlocking(false));
  cleanup();
});

describe('global dialogs while the legal terms gate blocks', () => {
  it('keeps a conflict that arrives during the gate and shows it only after the gate closes', async () => {
    act(() => setLegalTermsGateBlocking(true));
    render(<FeishuConflictDialogHost />);

    await act(async () => emitConflict?.({ appId: 'cli_fixture' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => setLegalTermsGateBlocking(false));
    expect(await screen.findByText(/cli_fixture|settings\.feishuBot/)).toBeTruthy();
  });
});
