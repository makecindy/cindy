import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isExactManualCompactCommand } from '@/lib/slashCommands';

const viewSource = readFileSync(
  new URL('../features/cc-agent/CCAgentSessionView.tsx', import.meta.url),
  'utf8',
);

describe('manual /compact command', () => {
  it('matches only the exact control command', () => {
    expect(isExactManualCompactCommand('/compact')).toBe(true);
    expect(isExactManualCompactCommand(' /compact ')).toBe(true);
    expect(isExactManualCompactCommand('/COMPACT')).toBe(true);
    expect(isExactManualCompactCommand('')).toBe(false);
    expect(isExactManualCompactCommand('/compact focus on API decisions')).toBe(false);
    expect(isExactManualCompactCommand('explain /compact')).toBe(false);
  });

  it('dispatches the command through the manual compact channels before sending it as a prompt', () => {
    expect(viewSource).toContain('await maybeCompactSession(message, payloadsAttached)');
    expect(viewSource).toContain('makerApiForSticky(sessionId).compactSession(sessionId)');
    expect(viewSource).toContain('await compactSession(');
  });

  it('never intercepts /compact that carries composer payloads', () => {
    // composer 已在调用 handleSend 前清空载荷:附件 / mention / 粘贴文本 / 内联引用
    // / agent 引用任一存在都必须走原发送路径,不能被拦截提前返回吞掉(#3744 review P1)。
    expect(viewSource).toContain('if (payloadsAttached) return false;');
    expect(viewSource).toContain('(opts?.agentReferences?.length ?? 0) > 0');
    expect(viewSource).toContain('(opts?.pastedTextRanges?.length ?? 0) > 0');
    expect(viewSource).toContain('opts?.quotesEncoded === true');
  });

  it('refuses the claude-input channel for SSH remote sessions instead of misrouting to the local maker', () => {
    expect(viewSource).toContain(
      "channel === 'claude-input' && sessionRef.current?.remoteHostId",
    );
  });

  it('shares the intercept with the NewMaker pending first-message path', () => {
    // 新建任务的首条消息由 pending 消费路径投递,不经 handleSend:必须与
    // handleSend 共用同一 /compact 拦截,否则首条 /compact 会被当成普通
    // prompt(Pi 下还会变成字面 /compact 用户消息,#3744 review P1)。
    expect(viewSource).toContain('await maybeCompactSession(pendingText, pendingPayloadsAttached)');
    expect(viewSource).toContain('pending.quotesEncoded === true');
  });
});
