import { beforeAll, describe, expect, it } from 'vitest';
import {
  APP_EXIT_INTERRUPTED_REASON,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '@cindy/maker-shared/synthetic-trigger';
import { i18n } from '@/i18n';
import {
  isContinuationQueueItem,
  resolveSessionTailBanner,
  type ResolveSessionTailBannerInput,
} from '@/session/sessionTailBannerModel';
import type { RemoteMessage } from '@/session/types';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function message(patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content' | 'createdAt'>): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    ...patch,
  };
}

function errorRow(id: string, createdAt: string, content: Record<string, unknown>): RemoteMessage {
  return message({ id, role: 'error', content: JSON.stringify(content), createdAt });
}

function baseInput(patch: Partial<ResolveSessionTailBannerInput> = {}): ResolveSessionTailBannerInput {
  return {
    messages: [],
    session: { activeTurnStartedAt: null, lastTurnEndedAt: null, clearedAt: null },
    projection: { error: null, credentialSwitchWait: null },
    isSessionStreaming: false,
    continuationInFlight: false,
    interruptAcked: false,
    hiddenErrorClientIds: new Set(),
    ...patch,
  };
}

describe('resolveSessionTailBanner — error-tail', () => {
  it('surfaces an undismissed trailing error row with retry semantics', () => {
    const state = resolveSessionTailBanner(baseInput({
      messages: [
        message({ id: 'u1', role: 'user', content: { text: '跑任务' }, createdAt: '2026-01-01T00:00:01.000Z' }),
        errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'process exited unexpectedly' }),
      ],
    }));
    expect(state).toEqual({
      kind: 'error-tail',
      clientId: 'e1',
      text: 'process exited unexpectedly',
      continueKind: 'error',
      retryable: true,
    });
  });

  it('maps legacy app-exit marker rows to the continue-task semantics', () => {
    const state = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', {
        message: 'interrupted',
        reason: APP_EXIT_INTERRUPTED_REASON,
      })],
    }));
    expect(state).toMatchObject({ kind: 'error-tail', continueKind: 'interrupted' });
  });

  it('replaces agent auth failures with guidance text and disables retry', () => {
    const state = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', {
        message: 'claude-code not authenticated: no_key',
      })],
    }));
    expect(state).toMatchObject({ kind: 'error-tail', retryable: false });
    expect((state as { text: string }).text).toContain('设置 → 模型供应商');
  });

  it('disables retry for codex stale-thread and invalid-encrypted tail errors', () => {
    // 对齐桌面 ErrorBanner hide-Retry 门控:这两类重试必撞同一失败循环
    const stale = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', {
        message: 'stream error: Thread not found for id thr_123',
      })],
    }));
    expect(stale).toMatchObject({ kind: 'error-tail', retryable: false });
    expect((stale as { text: string }).text).toContain('新建对话');

    const encrypted = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e2', '2026-01-01T00:00:02.000Z', {
        message: 'response contains invalid_encrypted_content for this provider',
      })],
    }));
    expect(encrypted).toMatchObject({ kind: 'error-tail', retryable: false });
    expect((encrypted as { text: string }).text).toContain('加密');
  });

  it('does not fire when the error row is dismissed, superseded, or locally hidden', () => {
    const dismissed = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom', dismissed: true })],
    }));
    expect(dismissed).toBeNull();

    const superseded = resolveSessionTailBanner(baseInput({
      messages: [
        errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom' }),
        message({ id: 'a1', role: 'assistant', content: '恢复后的回答', createdAt: '2026-01-01T00:00:03.000Z' }),
      ],
    }));
    expect(superseded).toBeNull();

    const hidden = resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom' })],
      hiddenErrorClientIds: new Set(['e1']),
    }));
    expect(hidden).toBeNull();
  });

  it('ignores trailing mobile-local system cards when locating the error tail', () => {
    const state = resolveSessionTailBanner(baseInput({
      messages: [
        errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom' }),
        message({
          id: 'mobile-system-pwd-123-abc',
          role: 'system',
          content: '',
          createdAt: '2026-01-01T00:00:03.000Z',
          systemCardType: 'pwd',
        }),
      ],
    }));
    expect(state).toMatchObject({ kind: 'error-tail', clientId: 'e1' });
  });

  it('suppresses the banner for live errors, streaming, waits, and in-flight continuations', () => {
    const messages = [errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom' })];
    expect(resolveSessionTailBanner(baseInput({
      messages,
      projection: { error: 'live 错误', credentialSwitchWait: null },
    }))).toBeNull();
    expect(resolveSessionTailBanner(baseInput({
      messages,
      projection: {
        error: null,
        credentialSwitchWait: { blockedBySessionIds: ['other'] },
      },
    }))).toBeNull();
    expect(resolveSessionTailBanner(baseInput({ messages, isSessionStreaming: true }))).toBeNull();
    // 在途续跑(pendingQueue + settling 并集由调用方计算)是单点抑制输入
    expect(resolveSessionTailBanner(baseInput({ messages, continuationInFlight: true }))).toBeNull();
  });

  it('classifies queue/settling items as continuations by exact prompt match only', () => {
    expect(isContinuationQueueItem({ text: CONTINUE_AFTER_ERROR_PROMPT })).toBe(true);
    expect(isContinuationQueueItem({ text: '普通消息' })).toBe(false);
    // 其它 UI trigger(Mivo 等)不推进失败 turn,前缀匹配会误抑制——必须精确匹配
    expect(isContinuationQueueItem({ text: '[UI_ACTION_TRIGGER] regenerate image' })).toBe(false);
  });
});

describe('resolveSessionTailBanner — interrupted(session 双时间戳)', () => {
  it('fires when the active turn started after it last ended and nothing acked it', () => {
    const state = resolveSessionTailBanner(baseInput({
      session: { activeTurnStartedAt: 2000, lastTurnEndedAt: 1000, clearedAt: null },
    }));
    expect(state).toEqual({ kind: 'interrupted' });
  });

  it('stays quiet when acked, ended, cleared past, or an error tail exists', () => {
    expect(resolveSessionTailBanner(baseInput({
      session: { activeTurnStartedAt: 2000, lastTurnEndedAt: 1000, clearedAt: null },
      interruptAcked: true,
    }))).toBeNull();
    expect(resolveSessionTailBanner(baseInput({
      session: { activeTurnStartedAt: 1000, lastTurnEndedAt: 2000, clearedAt: null },
    }))).toBeNull();
    expect(resolveSessionTailBanner(baseInput({
      session: {
        activeTurnStartedAt: 2000,
        lastTurnEndedAt: 1000,
        clearedAt: new Date(3000).toISOString(),
      },
    }))).toBeNull();
    // 历史中断行(error-tail)优先;它被本视图隐藏时也不冒出 interrupted 双横幅
    expect(resolveSessionTailBanner(baseInput({
      messages: [errorRow('e1', '2026-01-01T00:00:02.000Z', { message: 'boom' })],
      session: { activeTurnStartedAt: 2000, lastTurnEndedAt: 1000, clearedAt: null },
      hiddenErrorClientIds: new Set(['e1']),
    }))).toBeNull();
  });
});
