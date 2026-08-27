import { describe, expect, it, vi } from 'vitest';

import {
  INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
  INTERRUPTED_TURN_MAX_EPISODE_ATTEMPTS,
  InterruptedTurnAutoResumeGuard,
  interruptedTurnResumeDelayMs,
  isAutoResumeUserMessage,
  isInterruptedTurnError,
  isSubstantiveProgressEvent,
} from '../interruptedTurnAutoResume.js';

// 判定单测的核心是**白名单收紧**:自动重试一个确定性失败(认证过期、协议错)会反复
// 烧额度并反复报错,所以只有识别得了的"上游把 turn 打断了"才允许自愈。
describe('isInterruptedTurnError', () => {
  // 2026-07-30 实测的真实形态(Claude Code SDK 2.1.219 + Bedrock):SSE 流被中途切断,
  // terminal_reason='api_error'、sdkError='server_error'、无 HTTP 状态码。这条用例是
  // 回归锚 —— 上游改文案时它会先红。
  it('matches the real observed stream-truncation error', () => {
    expect(
      isInterruptedTurnError({
        sdkError: 'server_error',
        message: 'API Error: Connection closed mid-response. The response above may be incomplete.',
      }),
    ).toBe(true);
  });

  // 同一物理故障的第二种上游措辞(2026-07-30 实测,Cindy 真实会话日志:
  // terminalReason='api_error'、sdkError='server_error'、durationMs≈100s 即已有产出)。
  // 上一条锚的是 "Connection closed",这条锚的是 "Server error" —— 两条一起证明判定不能
  // 只挂在单一措辞上(这些字符串是 CLI 内部文案,不是协议字段)。
  it('matches the second observed wording of the same truncation', () => {
    expect(
      isInterruptedTurnError({
        sdkError: 'server_error',
        message: 'API Error: Server error mid-response. The response above may be incomplete.',
      }),
    ).toBe(true);
  });

  // Codex 的容量错误**一律**带 reason='upstream-overload'(translator 对每条都盖,
  // renderer 隔着 IPC 只能靠它本地化)。reason 门若不给它开例外,「容量 + 已有产出」
  // 这一格对 Codex 就是死代码 —— 而那一格正是本份要接的(codex review P1)。
  it('accepts the classified retryable overload reason (Codex 容量 + 已有产出)', () => {
    expect(
      isInterruptedTurnError({
        reason: 'upstream-overload',
        message: 'Selected model is at capacity. Please try a different model.',
      }),
    ).toBe(true);
    // 结构化 reason 比文案可靠:codex 改了容量措辞也照样接管。
    expect(
      isInterruptedTurnError({
        reason: 'upstream-overload',
        message: 'The upstream declined this request.',
      }),
    ).toBe(true);
  });

  it('accepts the classified Codex reconnect-stalled reason', () => {
    expect(
      isInterruptedTurnError({
        reason: 'codex_reconnect_stalled',
        message: 'Codex app-server stopped making progress while reconnecting.',
      }),
    ).toBe(true);
  });

  it('accepts the classified empty-response reason (#2320)', () => {
    // translator 只在「发起过 API 调用、零文本、零工具、零 usage 增量」的严格
    // 形态下盖这个 key —— 上游/网关返回退化空响应,与流被切断同属连接层故障,
    // 由既有连续失败上限与人工介入周期硬上限止损。
    expect(
      isInterruptedTurnError({
        reason: 'empty-response',
        message: 'The model returned an empty response.',
      }),
    ).toBe(true);
    // reason 是权威判据:不要求 sdkError tag,也不要求文案形态。
    expect(isInterruptedTurnError({ reason: 'empty-response' })).toBe(true);
  });

  it('rejects errors that carry a stable reason (已分类,另有处置路径)', () => {
    for (const reason of ['turn-failed', 'silent-stop-exhausted']) {
      expect(
        isInterruptedTurnError({
          sdkError: 'server_error',
          reason,
          message: 'Connection closed mid-response.',
        }),
        `reason=${reason} 必须交回用户`,
      ).toBe(false);
    }
  });

  it('带状态码时不再算"流被切断"(上游应答过);状态码本身不属于任何一类就不接管', () => {
    // 400 既不是过载(529 / at capacity)也不是网络类,截断文案在这里不再成立 ——
    // 上游应答过说明流没断,是请求本身被拒。
    expect(
      isInterruptedTurnError({
        sdkError: 'server_error',
        errorStatus: 400,
        message: 'Connection closed mid-response.',
      }),
    ).toBe(false);
  });

  it('rejects non-server_error SDK tags (认证/限额/计费/请求错都是确定性失败)', () => {
    for (const sdkError of [
      'authentication_failed',
      'rate_limit',
      'billing_error',
      'invalid_request',
      'max_output_tokens',
      undefined,
    ]) {
      expect(
        isInterruptedTurnError({
          ...(sdkError ? { sdkError } : {}),
          message: 'Connection closed mid-response.',
        }),
        `sdkError=${String(sdkError)} 不该自动续跑`,
      ).toBe(false);
    }
  });

  it('rejects server_error whose message is not a recognizable shape', () => {
    for (const message of ['', 'Internal server error', 'Unauthorized file system access']) {
      expect(isInterruptedTurnError({ sdkError: 'server_error', message })).toBe(false);
    }
    expect(isInterruptedTurnError({ sdkError: 'server_error' })).toBe(false);
  });

  // 第二类:网络到不了上游。同样是"连不上"而不是"请求有问题",且实际使用中最常见。
  // 这一类刻意不要求 server_error tag、也允许带状态码(502/503/504 本身就有)。
  it('accepts network-ish failures regardless of sdk tag or status', () => {
    for (const message of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:9',
      'socket hang up',
      'Request timed out',
      'API Error: The operation timed out.',
      'The operation timed out.',
      'OpenAI Responses stream ended before a terminal response event',
      'Connection error',
      'upstream unreachable',
      '502 Bad Gateway',
      'Service Unavailable',
      'API Error: upstream stream error: terminated',
      'upstream stream error: socket reset',
    ]) {
      expect(isInterruptedTurnError({ message }), `${message} 应自动重连`).toBe(true);
    }
    expect(isInterruptedTurnError({ message: '503 Service Unavailable', errorStatus: 503 })).toBe(
      true,
    );
  });

  // 第三类:上游没容量。与 #844 的分工靠「本 turn 有没有产出」划清(见判定函数注释),
  // 零产出的容量拒绝由 Codex 侧重投,本份只在已有产出时接手,两者互斥。
  it('accepts capacity / overload failures', () => {
    expect(
      isInterruptedTurnError({ message: 'Selected model is at capacity. Please try a different model.' }),
      'Codex 容量拒绝',
    ).toBe(true);
    expect(isInterruptedTurnError({ message: 'overloaded_error', errorStatus: 529 })).toBe(true);
    expect(isInterruptedTurnError({ message: 'upstream busy', errorStatus: 529 })).toBe(true);
  });

  // 确定性失败必须留在门外:重试它们只会反复烧额度并反复报同一个错。
  it('still rejects deterministic failures after widening', () => {
    for (const [label, signals] of [
      ['401 认证', { message: '401 Missing bearer token' }],
      ['认证 tag', { sdkError: 'authentication_failed', message: 'invalid api key' }],
      ['限额', { sdkError: 'rate_limit', message: 'rate limit exceeded', errorStatus: 429 }],
      ['计费', { sdkError: 'billing_error', message: 'credit balance too low' }],
      ['请求非法', { sdkError: 'invalid_request', message: 'prompt too long' }],
      ['codex thread', { message: 'thread not found' }],
      ['加密内容失效', { message: 'invalid encrypted content' }],
      ['Pi auto-retry 耗尽后交给用户点重试', { reason: 'pi-gateway-drop', message: 'The operation timed out.' }],
      ['Codex 鉴权会话结束', { message: 'app_session_terminated' }],
    ] as Array<[string, Parameters<typeof isInterruptedTurnError>[0]]>) {
      expect(isInterruptedTurnError(signals), `${label} 不该自动重连`).toBe(false);
    }
  });
});

// 这个判据决定「要不要给自动续跑守卫充值额度」。判错的后果不对称:把自动补发误判成
// 人类动作 = 自我充值 = 防死循环的硬保证失效。
describe('isAutoResumeUserMessage', () => {
  it('only trusts the agentMeta.autoResume flag', () => {
    expect(isAutoResumeUserMessage({ autoResume: true })).toBe(true);
    expect(isAutoResumeUserMessage({ autoResume: true, delivery: 'turn' })).toBe(true);
    expect(isAutoResumeUserMessage({ autoResume: false })).toBe(false);
    expect(isAutoResumeUserMessage({ delivery: 'turn' })).toBe(false);
    expect(isAutoResumeUserMessage({})).toBe(false);
    expect(isAutoResumeUserMessage(undefined)).toBe(false);
    expect(isAutoResumeUserMessage(null)).toBe(false);
  });

  it('does not accept truthy-but-not-true values (避免 "true" / 1 这类脏数据放行)', () => {
    expect(isAutoResumeUserMessage({ autoResume: 'true' })).toBe(false);
    expect(isAutoResumeUserMessage({ autoResume: 1 })).toBe(false);
  });

  it('never infers from the message body (人可以手发一条一模一样的续跑文本)', () => {
    // 正文不参与判定 —— 只要没有标记就是人类动作,照常充值。
    expect(
      isAutoResumeUserMessage({ content: '[UI_ACTION_TRIGGER] continue the task' }),
    ).toBe(false);
  });
});

// 「有产出」是连续失败计数归零、上一次重连判成成功的唯一证据。空文本必须排除:
// 否则一个什么都没产出的重连会绕过上限,并在历史里错误显示「已重新连接」(P1 ×2)。
describe('isSubstantiveProgressEvent', () => {
  it('counts tool_use and non-empty text only', () => {
    expect(isSubstantiveProgressEvent({ type: 'tool_use', data: {} })).toBe(true);
    expect(isSubstantiveProgressEvent({ type: 'text', data: { text: 'x' } })).toBe(true);
  });

  it('rejects empty text (translator 在若干路径上会推 text: "")', () => {
    expect(isSubstantiveProgressEvent({ type: 'text', data: { text: '' } })).toBe(false);
    expect(isSubstantiveProgressEvent({ type: 'text', data: {} })).toBe(false);
    expect(isSubstantiveProgressEvent({ type: 'text', data: null })).toBe(false);
    expect(isSubstantiveProgressEvent({ type: 'text', data: { text: 123 } })).toBe(false);
  });

  // 两侧 translator 转发的 text block / delta 内容是任意的,纯空白同样会原样透出。算成产出
  // 的话:空白 delta 可以让连续失败计数永远停在 1/5(绕过上限),历史里还会显示成
  // 「已重新连接」—— 而用户一个字都没看到(codex P1)。
  it('rejects whitespace-only text (用户什么都没看到,不能算产出)', () => {
    for (const text of [' ', '\n', '\n\n', '\t', '  \r\n  ']) {
      expect(
        isSubstantiveProgressEvent({ type: 'text', data: { text } }),
        `text=${JSON.stringify(text)} 不该算产出`,
      ).toBe(false);
    }
    // 夹着空白的真实产出仍然算:实义字符是唯一判据。
    expect(isSubstantiveProgressEvent({ type: 'text', data: { text: '\n好的' } })).toBe(true);
  });

  // 零宽字符是 trim() 的盲区(它只认 \s):只有零宽字符的 text 会被 trim 误判成有内容,
  // 于是自动重连绕过 5 次上限、历史里还显示「已重新连接」(greptile P2)。判据已收敛到
  // shared/visibleText.ts,这条锁的是 main 侧真的接上了它。
  it('rejects zero-width-only text (trim 的盲区)', () => {
    for (const text of ['\u200B', '\uFEFF', '\u200B\u200B\n \u200D', '\u00AD']) {
      expect(
        isSubstantiveProgressEvent({ type: 'text', data: { text } }),
        `text=${JSON.stringify(text)} 用户看不见,不该算产出`,
      ).toBe(false);
    }
    expect(isSubstantiveProgressEvent({ type: 'text', data: { text: '\u200B好' } })).toBe(true);
  });

  it('rejects thinking / status / done and other event types', () => {
    for (const type of ['thinking', 'status', 'done', 'error', 'tool_result', undefined]) {
      expect(
        isSubstantiveProgressEvent({ ...(type ? { type } : {}), data: { text: 'x' } }),
        `${String(type)} 不算产出`,
      ).toBe(false);
    }
  });
});

describe('interruptedTurnResumeDelayMs', () => {
  it('applies exponential backoff with jitter, capped after jitter', () => {
    // random=0.5 → jitter 系数 1.0,拿到裸的指数序列。
    expect(interruptedTurnResumeDelayMs(1, () => 0.5)).toBe(3_000);
    expect(interruptedTurnResumeDelayMs(2, () => 0.5)).toBe(6_000);
    expect(interruptedTurnResumeDelayMs(3, () => 0.5)).toBe(12_000);
    // 第 4、5 次触顶:连续 5 次总等待 ≈ 3+6+12+20+20 = 61s。
    expect(interruptedTurnResumeDelayMs(4, () => 0.5)).toBe(20_000);
    expect(interruptedTurnResumeDelayMs(5, () => 0.5)).toBe(20_000);
    // 触顶后即使 jitter 往上拉也不越过上限(与 overloadRetryDelayMs 同款约束)。
    expect(interruptedTurnResumeDelayMs(9, () => 0.999)).toBe(20_000);
    // jitter 下界:系数 0.75。
    expect(interruptedTurnResumeDelayMs(1, () => 0)).toBe(2_250);
  });
});

function createGuard(opts?: { enabled?: boolean }) {
  let nowMs = 1_000_000;
  const guard = new InterruptedTurnAutoResumeGuard({
    isEnabled: () => opts?.enabled ?? true,
    log: { debug: vi.fn(), warn: vi.fn() },
    now: () => nowMs,
    random: () => 0.5,
  });
  const tick = (ms: number) => {
    nowMs += ms;
  };
  return { guard, tick, now: () => nowMs };
}

const SID = 'session-1';

/** 一个完整的「turn 开始 → 被打断」周期，返回 error 观察时刻。 */
function runInterruptedTurn(g: ReturnType<typeof createGuard>): number {
  g.guard.noteTurnStarted(SID);
  g.tick(30_000);
  return g.now();
}

// 额度模型的核心不变量:连续 N 次零产出会停；即使每次都有一点产出，同一次真人介入
// 之后也受 episode 硬上限保护，绝不无限自动循环。
describe('InterruptedTurnAutoResumeGuard', () => {
  it('grants up to MAX consecutive attempts, then stops and waits for the user', () => {
    const g = createGuard();
    for (let i = 1; i <= INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS; i++) {
      const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
      expect(decision.action, `第 ${i} 次应放行`).toBe('resume');
      if (decision.action === 'resume') {
        expect(decision.attempt).toBe(i);
        expect(decision.maxAttempts).toBe(INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS);
        expect(decision.sessionTotal).toBe(i);
      }
    }
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g))).toEqual({
      action: 'exhausted',
      reason: 'consecutive',
      consecutiveAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
      episodeAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
    });
  });

  it('does not recharge exhausted retry budget from a late background tool event', () => {
    const g = createGuard();
    for (let i = 0; i < INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS; i += 1) {
      const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
      expect(decision.action).toBe('resume');
      if (decision.action !== 'resume') return;
      g.guard.noteAttemptEvent(SID, decision.attemptToken);
      g.guard.noteAttemptSettled(SID, decision.attemptToken);
    }
    expect(g.guard.onInterruptedTurn(SID, g.now()).action).toBe('exhausted');

    // This models the state-machine side of the listener guard; the source
    // contract test separately locks that register.ts uses the same condition.
    const lateBackgroundToolUse = { type: 'tool_use', turnScope: 'background' };
    if (
      lateBackgroundToolUse.turnScope !== 'background' &&
      isSubstantiveProgressEvent(lateBackgroundToolUse)
    ) {
      g.guard.noteProgress(SID);
    }

    expect(g.guard.onInterruptedTurn(SID, g.now() + 1)).toEqual({
      action: 'exhausted',
      reason: 'consecutive',
      consecutiveAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
      episodeAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
    });
  });

  it('model output resets the consecutive counter (但会话累计只增)', () => {
    const g = createGuard();
    let lastAttemptToken = 0;
    // 先耗光连续额度。
    for (let i = 0; i < INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS; i++) {
      const granted = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
      expect(granted.action).toBe('resume');
      if (granted.action === 'resume') lastAttemptToken = granted.attemptToken;
    }
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g)).action).toBe('exhausted');

    // 连上了、模型有输出 → 归零,又能再来一整轮。
    expect(g.guard.noteProgress(SID, lastAttemptToken)).toBe(true);
    const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(decision.action).toBe('resume');
    if (decision.action === 'resume') {
      expect(decision.attempt, '本轮计数已归零').toBe(1);
      // 会话累计不重置 —— 它是"这个任务到底重连过多少次"的展示值。
      expect(decision.sessionTotal).toBe(INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS + 1);
    }
  });

  it('即使每次都有进展,同一人工介入周期仍受硬总上限保护', () => {
    const g = createGuard();
    for (let round = 0; round < INTERRUPTED_TURN_MAX_EPISODE_ATTEMPTS; round++) {
      const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
      expect(decision.action).toBe('resume');
      if (decision.action === 'resume') {
        expect(decision.episodeAttempt).toBe(round + 1);
        expect(decision.sessionTotal).toBe(round + 1);
        expect(g.guard.noteProgress(SID, decision.attemptToken)).toBe(true);
      }
    }
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g))).toEqual({
      action: 'exhausted',
      reason: 'episode',
      consecutiveAttempts: 0,
      episodeAttempts: INTERRUPTED_TURN_MAX_EPISODE_ATTEMPTS,
    });
  });

  it('noteProgress 在没有失败计数时是 no-op(热路径每条消息都会调)', () => {
    const g = createGuard();
    g.guard.noteProgress(SID);
    g.guard.noteProgress(SID);
    const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(decision.action).toBe('resume');
    if (decision.action === 'resume') expect(decision.attempt).toBe(1);
  });

  it('真实用户消息也重置连续计数(人工介入是新起点)', () => {
    const g = createGuard();
    for (let i = 0; i < INTERRUPTED_TURN_MAX_EPISODE_ATTEMPTS; i++) {
      const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
      expect(decision.action).toBe('resume');
      if (decision.action === 'resume') {
        expect(g.guard.noteProgress(SID, decision.attemptToken)).toBe(true);
      }
    }
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g)).action).toBe('exhausted');
    g.guard.noteUserSend(SID);
    const decision = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(decision.action).toBe('resume');
    if (decision.action === 'resume') {
      expect(decision.episodeAttempt).toBe(1);
      expect(decision.attempt).toBe(1);
    }
  });

  it('真人接管后拒绝旧 attempt 的迟到进展', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') return;

    g.guard.noteUserSend(SID);

    expect(g.guard.noteProgress(SID, first.attemptToken)).toBe(false);
    const next = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(next.action).toBe('resume');
    if (next.action === 'resume') {
      expect(next.attempt).toBe(1);
      expect(next.episodeAttempt).toBe(1);
    }
  });

  it('每次重连都带退避,连续重试不被最小间隔掐死', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, g.now());
    expect(first.action === 'resume' && first.delayMs).toBe(3_000);
    g.guard.noteTurnStarted(SID); // 新 turn 起来又立刻被打断
    const second = g.guard.onInterruptedTurn(SID, g.now());
    // 旧实现有 30s min-interval,这里会变成 exhausted —— 那会让「连续 5 次」永远只跑到 1 次。
    expect(second.action).toBe('resume');
    expect(second.action === 'resume' && second.delayMs).toBe(6_000);
  });

  it('skips while a previous resume is still pending (重复投递的 error 不连发)', () => {
    const g = createGuard();
    const erroredAt = runInterruptedTurn(g);
    expect(g.guard.onInterruptedTurn(SID, erroredAt).action).toBe('resume');
    expect(g.guard.onInterruptedTurn(SID, erroredAt)).toEqual({ action: 'skip', why: 'pending' });
  });

  it('迟到的旧 status 起始事件不会清掉已排期的自动续跑', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');

    // terminal error 后 provider 可能补发旧 status(isRunning=true)。它没有 host token，
    // 不能冒领下一次自动续跑的 pending；只有 tokened event / 显式失败路径才能清理。
    g.guard.noteTurnStarted(SID, { clearPending: false });
    expect(g.guard.onInterruptedTurn(SID, g.now())).toEqual({ action: 'skip', why: 'pending' });
    expect(g.guard.noteAttemptEvent(SID, first.attemptToken)).toBe(true);
  });

  it('noteResumeSendFailed clears pending so the next error can be decided again', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected resume');
    expect(g.guard.noteResumeSendFailed(SID, first.attemptToken)).toBe(true);
    const again = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(again.action, '不再卡在 pending').toBe('resume');
    // 计数不回退(安全方向):失败的那次仍然算一次。
    if (again.action === 'resume') expect(again.attempt).toBe(2);
  });

  it('派发失败后 token 失效，后续无 token 的自动 turn 产出仍能重置连续计数', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');

    expect(g.guard.noteResumeSendFailed(SID, first.attemptToken)).toBe(true);
    expect(g.guard.noteProgress(SID)).toBe(true);
    const next = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(next.action).toBe('resume');
    if (next.action === 'resume') expect(next.attempt).toBe(1);
  });

  it('a tokened provider event clears pending even without status(isRunning=true)', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');

    expect(g.guard.noteAttemptEvent(SID, first.attemptToken)).toBe(true);
    const second = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(second.action).toBe('resume');
    if (second.action === 'resume') expect(second.attempt).toBe(2);
  });

  it('retires a settled attempt owner before accepting untagged automatic progress', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');

    expect(g.guard.noteAttemptEvent(SID, first.attemptToken)).toBe(true);
    expect(g.guard.noteAttemptSettled(SID, first.attemptToken)).toBe(true);
    expect(g.guard.noteProgress(SID, first.attemptToken)).toBe(false);
    expect(g.guard.noteProgress(SID)).toBe(true);

    const next = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(next.action).toBe('resume');
    if (next.action === 'resume') expect(next.attempt).toBe(1);
  });

  it('allows consecutive terminal-only failures to consume the budget', () => {
    const g = createGuard();
    const attempts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const decision = g.guard.onInterruptedTurn(SID, g.now());
      expect(decision.action).toBe('resume');
      if (decision.action !== 'resume') return;
      attempts.push(decision.attempt);
      // Simulate a provider that reports terminal error directly and never emits status(true).
      g.guard.noteAttemptEvent(SID, decision.attemptToken);
    }
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('ignores a stale tokened event after a newer attempt or user intervention', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');
    g.guard.noteAttemptEvent(SID, first.attemptToken);

    g.guard.noteUserSend(SID);
    expect(g.guard.noteAttemptEvent(SID, first.attemptToken)).toBe(false);
    const fresh = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(fresh.action).toBe('resume');
    if (fresh.action === 'resume') expect(fresh.attempt).toBe(1);
  });

  it('迟到的旧 attempt 不能清掉当前新 attempt', () => {
    const g = createGuard();
    const first = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(first.action).toBe('resume');
    if (first.action !== 'resume') throw new Error('expected first resume');

    g.guard.noteTurnStarted(SID);
    const second = g.guard.onInterruptedTurn(SID, g.now());
    expect(second.action).toBe('resume');
    if (second.action !== 'resume') throw new Error('expected second resume');

    expect(g.guard.noteResumeSendFailed(SID, first.attemptToken)).toBe(false);
    expect(g.guard.isCurrentAttempt(SID, second.attemptToken)).toBe(true);
    expect(g.guard.noteResumeSendFailed(SID, second.attemptToken)).toBe(true);
  });

  it('skips when the user already sent something after the error (绝不插队)', () => {
    const g = createGuard();
    const erroredAt = runInterruptedTurn(g);
    g.tick(1_000);
    g.guard.noteUserSend(SID);
    expect(g.guard.onInterruptedTurn(SID, erroredAt)).toEqual({
      action: 'skip',
      why: 'superseded',
    });
  });

  it('skips when a new turn already started after the error', () => {
    const g = createGuard();
    const erroredAt = runInterruptedTurn(g);
    g.tick(1_000);
    g.guard.noteTurnStarted(SID);
    expect(g.guard.onInterruptedTurn(SID, erroredAt)).toEqual({
      action: 'skip',
      why: 'superseded',
    });
  });

  it('noteSessionReset 清零连续计数并让已排期的续跑作废', () => {
    const g = createGuard();
    const erroredAt = runInterruptedTurn(g);
    expect(g.guard.onInterruptedTurn(SID, erroredAt).action).toBe('resume');
    g.tick(1_000);
    g.guard.noteSessionReset(SID); // /clear 或 abort
    expect(g.guard.onInterruptedTurn(SID, erroredAt)).toEqual({
      action: 'skip',
      why: 'superseded',
    });
    const fresh = g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    expect(fresh.action === 'resume' && fresh.attempt, '计数已归零').toBe(1);
  });

  it('kill switch disables the guard entirely', () => {
    const g = createGuard({ enabled: false });
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g))).toEqual({
      action: 'skip',
      why: 'disabled',
    });
  });

  it('keeps per-session accounting isolated', () => {
    const g = createGuard();
    const other = 'session-2';
    for (let i = 0; i < INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS; i++) {
      g.guard.onInterruptedTurn(SID, runInterruptedTurn(g));
    }
    expect(g.guard.onInterruptedTurn(SID, runInterruptedTurn(g)).action).toBe('exhausted');
    // 另一个任务自己的账:第一次照常放行。
    const otherDecision = g.guard.onInterruptedTurn(other, g.now());
    expect(otherDecision.action).toBe('resume');
    if (otherDecision.action === 'resume') expect(otherDecision.sessionTotal).toBe(1);
  });
});
