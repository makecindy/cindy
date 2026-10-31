// @vitest-environment jsdom
/**
 * usePinSuggestion — 多窗口共用打开历史时不互相覆盖。
 * ---------------------------------------------------------------------------
 * 入口与结果:主窗口与任务副窗口各挂一份侧栏(各自一个 usePinSuggestion),共用同一份
 *   按账号的本机存储;一个窗口点「不再提示」后,另一个窗口再记录打开,存储里的关闭
 *   记录必须还在。
 * 规则依据:PR #8265 review(Greptile):各窗口用自己的旧记录整份写回会抹掉对方刚写的
 *   「不再提示」,提示随之复活。
 * 覆盖缺口:纯函数测试只覆盖单份记录的计分与去重,不覆盖 hook 的读-改-写。
 * 最小失败输入:A、B 同时挂载(都读到空记录)→ A 关闭 x → B 记录打开 y。
 * tier:unit(jsdom,需要渲染 hook,故单独成文件)。实测约 1.5s。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usePinSuggestion } from '../features/cc-agent/hooks/usePinSuggestion';
import { __testing as ownerStorageTesting } from '@/lib/sidebarOwnerStorage';

const OWNER = 'owner-a';
const KEY = `sidebar.sessionOpenHistory.v1.owner.${OWNER}`;

beforeEach(() => {
  localStorage.clear();
  ownerStorageTesting.setOwnerAuthorityReader(() => ({
    dataOwnerId: OWNER,
    ownerGeneration: 1,
    claimed: true,
    canInitialize: true,
    pinnedLegacyConsumed: true,
  }));
});

afterEach(() => {
  cleanup();
  ownerStorageTesting.setOwnerAuthorityReader(null);
});

describe('usePinSuggestion 多窗口', () => {
  it('一个窗口记录打开时保留另一个窗口刚写的「不再提示」', () => {
    const windowA = renderHook(() => usePinSuggestion(OWNER, undefined, []));
    const windowB = renderHook(({ opened }) => usePinSuggestion(OWNER, opened, []), {
      initialProps: { opened: undefined as string | undefined },
    });

    act(() => windowA.result.current.dismiss('x'));
    windowB.rerender({ opened: 'y' });

    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored.dismissed).toEqual(['x']);
    expect(Object.keys(stored.opens)).toEqual(['y']);
  });
});
