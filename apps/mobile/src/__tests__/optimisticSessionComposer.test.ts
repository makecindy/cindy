/**
 * 会话参数未就绪(新建在途 / 缓存种入)时 composer 保持正常,发送走 outbox 排队。
 *
 * 这两种状态原先经 buildSessionOperationLayout 的 readOnlyReason 进来,共享模型据此把
 * 整个输入框换成「只读模式」卡片——每次新建会话都必然经过几秒,观感是「刚发出消息就
 * 变只读」。现在 composer 全程可用,派发由 outboxDispatchBlockedNow 挡住,就绪后自动
 * pump;顺序靠「sendAtMs 在 dispatch 时才生成」保证(见 newSessionCreation.ts 的
 * sendAtMs 注释)。
 *
 * mobile 没有组件渲染测试设施(惯例见 chatQuoteCrossDevice.test.ts),这里做源码级接线
 * 断言:门在该在的位置、失败路径不放行、设置类 RPC 仍被挡。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const SCREEN = 'app/sessions/[sessionId].tsx';

describe('mobile optimistic composer while session is not ready', () => {
  it('keeps the composer out of the read-only slot and only gates queue rows', () => {
    const source = readSource(SCREEN);

    // composer 只认真正的协作只读理由。
    expect(source).toContain('      readOnlyReason: composerReadOnlyReason,\n');
    expect(source).not.toContain('readOnlyReason: cacheSeededReason');
    // 队列行(取消 / 编辑 / 插队都是打到被控端队列的 RPC)仍然只读。
    expect(source).toContain('const queueInlineReadOnlyReason = collaborationReadOnlyReason\n    ?? cacheSeededReason\n    ?? pendingCreationReason');
  });

  it('blocks outbox dispatch until the session row can actually be sent with', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const outboxDispatchBlockedNow = () => {');
    expect(source).toContain('if (row.cacheSeeded) return true;');
    expect(source).toContain('if (row.pendingLocalCreation) return true;');
    expect(source).toContain('return getNewSessionCreationTask(sessionId) !== null;');
    // pump 循环每轮都看当下真相,blocked 时留住条目(不标失败)。
    expect(source).toContain('if (outboxDispatchBlockedNow()) return;');
    // 解禁那一帧重新 pump。
    expect(source).toContain('const outboxDispatchBlocked = !currentSession');
    expect(source).toContain('if (outboxDispatchBlocked) return;\n    void pumpOutbox();');
  });

  it('routes sends through the outbox while blocked and defers the workingDir check', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const dispatchBlockedAtSend = outboxDispatchBlockedNow();');
    expect(source).toContain('|| dispatchBlockedAtSend)) {');
    // dialogue 会话的 workingDir 由被控端在创建时分配,合成行此刻为空 —— 校验推迟到
    // dispatch(那时会重读 store 拿权威值),否则新建对话发消息会被误判成缺工作目录。
    expect(source).toContain('if (!dispatchBlockedAtSend && !currentSession.workingDir) {');
  });

  it('holds back queued messages when the first message failed to enqueue', () => {
    const source = readSource(SCREEN);
    const branchStart = source.indexOf("if (status === 'enqueue-failed') {");
    const branchEnd = source.indexOf('void load();', branchStart);
    const branch = source.slice(branchStart, branchEnd);

    // 失败标记必须落在 dismiss 之前:dismiss 会解禁 pump。
    expect(branch).toContain('outboxItemWithEnqueueFailure(item, heldBackReason)');
    expect(branch).toContain("t('session.screen.queuedAfterFirstMessageFailed')");
    expect(branch.indexOf('outboxItemWithEnqueueFailure'))
      .toBeLessThan(branch.indexOf('dismissNewSessionCreation(sessionId)'));
  });

  it('still blocks session-settings RPCs until the session exists remotely', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const sessionSettingsLocked = currentSession?.pendingLocalCreation === true;');
    // 硬门在统一入口,覆盖全部 runControlAction 调用点。
    expect(source).toContain('if (sessionSettingsLocked) return;\n    setControlBusy(true);');
    expect(source).toContain('disabled={!canUseComposer || controlBusy || sessionSettingsLocked}');
  });
});
