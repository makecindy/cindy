/**
 * 未确认发出的消息:徽标必须是转圈,不是「排入队尾」。
 *
 * 「已排队」是一句事实断言(被控端已收下这条消息);enqueue RPC 在途、已出队等
 * 回流、附件上传中都还没有这个事实,弱网下这段窗口可达数秒且可能回滚。
 *
 * 气泡本身已经是消息流的渲染项(pending_send),判定集中在 pendingSendItems.ts 的纯函数里
 * ——那部分有 pendingSendItems.test.ts 覆盖行为;这里只锁「屏幕侧把在途集合喂进去」和
 * 「渲染层按 phase 转圈」这两处接线。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const SCREEN = 'app/sessions/[sessionId].tsx';

describe('mobile sending queue badge', () => {
  it('spins for every phase that has not been confirmed as queued', () => {
    const items = readSource('src/session/pendingSendItems.ts');
    expect(items).toContain("return phase === 'sending' || phase === 'settling' || phase === 'uploading';");

    const bubble = readSource('src/session/PendingSendBubble.tsx');
    // 失败优先画 ⚠,其余未确认态转圈,已确认入队才画「时钟 + 已排队」明确标记。
    expect(bubble).toContain('const spinning = pendingSendSpins(item.phase);');
    expect(bubble).toContain('<ActivityIndicator color={colors.textTertiary} size="small" />');
    expect(bubble).toContain('<Clock3 color={colors.textTertiary}');
    expect(bubble).toContain('testID={`pendingSend.queuedStatus.${item.clientId}`}');
    expect(bubble).toContain("{t('message.queue.queuedStatus')}");
    expect(bubble).not.toContain('<ListEnd color={colors.textTertiary}');
    // 状态徽标悬挂在 86% 气泡外,不能挤窄长消息并让落定前后重新换行。
    expect(bubble).toContain("bubbleShell: { alignItems: 'flex-end', flexShrink: 1, maxWidth: '86%', position: 'relative' }");
    expect(bubble).toContain("position: 'absolute',\n    right: '100%',");
    expect(bubble).toContain("maxWidth: '100%',\n    opacity: 0.62,");
    // 在途条目的无障碍播报不能说「排队中第 N 条」。
    expect(bubble).toContain("t('message.queue.sendingMessage', { text: bubbleLabel })");
  });

  it('feeds the in-flight enqueue set into the pending bubbles', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('sendingClientIds: sendingQueueBadgeClientIds,');
    // 直发路径与 outbox 交接路径各 mark 一次,各自在 finally 收掉。
    expect(source.match(/markQueueItemSending\(queued\.clientId\);/g)).toHaveLength(2);
    expect(source.match(/clearQueueItemSending\(queued\.clientId\);/g)).toHaveLength(2);
    expect(source).toContain('} finally {\n        // 成功、对账认定已入队、回滚 throw 三条路径都算「不再在途」');
    // 新建会话乐观管线在跑时,首条消息同样是「已上屏未确认」。
    expect(source).toContain("creationTask?.status === 'running'");
    expect(source).toContain('creationTask.firstMessageClientId');
  });
});
