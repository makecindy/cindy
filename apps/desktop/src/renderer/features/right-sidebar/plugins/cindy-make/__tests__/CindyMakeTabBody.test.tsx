// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChatSessionFileValue } from '@/components/chat/ChatSessionFileContext';
import type { TabKindHostContext } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/cindy-make/CindyMakePreflightDialog', () => ({ CindyMakePreflightDialog: () => null }));
const chat = vi.hoisted(() => ({
  messages: [],
  historyLoaded: true,
  isStreaming: false,
  isLoadingMore: false,
  hasMoreMessages: false,
  historyWindowIslands: [],
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribe: () => () => {},
    getSnapshot: () => chat,
    ensureInitialMessages: () => {},
    loadOlderMessages: () => {},
  },
}));
// 消息列表本身很重；这里只保留它构造会话文件上下文的那一步，看侧栏给出的执行端是否让
// 本地-only 能力(嵌入媒体的任务目录搜索)按归属开关。
vi.mock('@/components/chat/MessageStream', () => ({
  MessageStream: (props: { sessionId: string; workingDir: string; remoteHostId?: string | null; ownerDeviceId?: string | null }) => {
    const value = useChatSessionFileValue(props.sessionId, props.workingDir, props.remoteHostId, props.ownerDeviceId);
    return <div data-testid="stream" data-local-confirmed={String(value.localConfirmed)} data-origin={value.origin.kind} />;
  },
}));

import { CindyMakeTabBody } from '../CindyMakeTabBody';

function ctx(owner: Pick<TabKindHostContext, 'remoteHostId' | 'deviceLinkDeviceId'>): TabKindHostContext {
  return {
    tabId: 'tab', sessionId: 's1', workdir: '/task', patchState: () => {}, onVisibilityChange: () => {},
    setCloseInterceptor: () => () => {}, ...owner,
  };
}

describe('CindyMakeTabBody task ownership', () => {
  afterEach(cleanup);

  it.each([
    ['a confirmed-local task', { remoteHostId: null, deviceLinkDeviceId: null }, 'true', 'local'],
    ['a task on another device', { remoteHostId: null, deviceLinkDeviceId: 'mac-a' }, 'false', 'local'],
    ['a task whose device is not resolved yet', { remoteHostId: null, deviceLinkDeviceId: undefined }, 'false', 'local'],
    ['an SSH task', { remoteHostId: 'host-1', deviceLinkDeviceId: null }, 'false', 'ssh'],
  ] as const)('passes the host ownership of %s to the message stream', (_label, owner, localConfirmed, origin) => {
    render(<CindyMakeTabBody state={{ taskSessionId: null }} ctx={ctx(owner)} />);
    const stream = screen.getByTestId('stream');
    expect(stream.getAttribute('data-local-confirmed')).toBe(localConfirmed);
    expect(stream.getAttribute('data-origin')).toBe(origin);
  });
});
