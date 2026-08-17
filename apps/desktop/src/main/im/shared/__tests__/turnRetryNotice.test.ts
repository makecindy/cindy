/**
 * 渠道侧「正在自动重试 / 重试耗尽」文案映射。
 *
 * 断言的是判定边界: 只有过载类非终止 error 才出提示, 其它非终止 error 保持既有
 * 静默(它们的 message 是内部英文串, 外发等于把裸英文推给渠道用户)。
 */
import { describe, expect, it } from 'vitest';

import {
  overloadFailureNotice,
  overloadRetryNotice,
  terminalErrorText,
  turnRetryNotice,
} from '../turnRetryNotice';

describe('turnRetryNotice', () => {
  it('终态 429 外层重投 → 渠道侧限流进度', () => {
    expect(
      turnRetryNotice({
        message:
          'exceeded retry limit, last status: 429 Too Many Requests (rate-limit-retry 1/2)',
        reason: 'terminal-rate-limit-retry',
      }),
    ).toBe('请求受到限流，正在自动重试（1/2）…');
  });

  it('reason 与 marker 必须同时命中，普通 429 仍保持静默', () => {
    expect(
      turnRetryNotice({
        message: 'provider failed (rate-limit-retry 1/2)',
        reason: 'other-reason',
      }),
    ).toBeNull();
    expect(
      turnRetryNotice({
        message: 'HTTP 429 Too Many Requests',
        reason: 'terminal-rate-limit-retry',
      }),
    ).toBeNull();
    expect(turnRetryNotice({ message: 'rate limit exceeded', errorStatus: 429 })).toBeNull();
  });

  it('继续覆盖原有过载进度', () => {
    expect(
      turnRetryNotice({
        message: 'Selected model is at capacity. (auto-retry 2/4)',
      }),
    ).toBe('模型服务繁忙，正在自动重试（2/4）…');
  });
});

describe('overloadRetryNotice', () => {
  it('带次数的 Codex 容量重投 → 带进度的中文提示', () => {
    expect(
      overloadRetryNotice({
        message: 'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
      }),
    ).toBe('模型服务繁忙，正在自动重试（2/4）…');
  });

  it('Claude SDK 的 529 重试同样命中(状态码优先于文本)', () => {
    expect(
      overloadRetryNotice({
        message: 'SDK API request failed: overloaded (HTTP 529) (auto-retry 3/10)',
        errorStatus: 529,
      }),
    ).toBe('模型服务繁忙，正在自动重试（3/10）…');
  });

  it('拿不到次数时不编造分母', () => {
    expect(overloadRetryNotice({ message: 'model is at capacity' })).toBe(
      '模型服务繁忙，正在自动重试…',
    );
  });

  it('非过载的非终止 error 保持静默', () => {
    // #790 的 Codex 网络重连提示走同一条非终止 error 通道, 但渠道侧没有对应文案。
    expect(overloadRetryNotice({ message: 'stream disconnected (Reconnecting 1/3)' })).toBeNull();
    expect(overloadRetryNotice({ message: 'rate limit exceeded', errorStatus: 429 })).toBeNull();
    expect(overloadRetryNotice({ message: '缓存 capacity 已满' })).toBeNull();
  });

  it('形状异常一律静默, 不抛', () => {
    expect(overloadRetryNotice(null)).toBeNull();
    expect(overloadRetryNotice(undefined)).toBeNull();
    expect(overloadRetryNotice('at capacity')).toBeNull();
    expect(overloadRetryNotice({})).toBeNull();
    expect(overloadRetryNotice({ message: 42 })).toBeNull();
  });

  it('结构化 codexErrorInfo 命中时不依赖文案措辞', () => {
    // codex 改了过载文案后, 只认文案会让整段退避窗口在渠道侧一个字都不动 —— 也就是
    // 本文件开头描述的那个"卡死了"观感复发。
    expect(
      overloadRetryNotice({
        message: 'The upstream declined this request. (auto-retry 2/4)',
        codexErrorInfo: 'serverOverloaded',
      }),
    ).toBe('模型服务繁忙，正在自动重试（2/4）…');
    // 只有 tag、没有 message 时也要出提示(空 payload 守卫不能把它挡掉)。
    expect(overloadRetryNotice({ codexErrorInfo: 'serverOverloaded' })).toBe(
      '模型服务繁忙，正在自动重试…',
    );
  });

  it('非过载的结构化 tag 保持静默', () => {
    expect(
      overloadRetryNotice({ message: 'stream gone', codexErrorInfo: 'responseStreamDisconnected' }),
    ).toBeNull();
    expect(overloadRetryNotice({ message: 'boom', codexErrorInfo: 'usageLimitExceeded' })).toBeNull();
  });
});

describe('overloadFailureNotice', () => {
  it('过载终态 → 指明「在这里重发」而不是桌面端重试', () => {
    const notice = overloadFailureNotice(
      'Selected model is at capacity. Please try a different model.',
    );
    expect(notice).not.toBeNull();
    // 关键承诺: 桌面端点重试起的是新 turn, 结果不回流到这条渠道消息。
    expect(notice).toContain('在这里重发这条消息');
    expect(notice).toContain('不会回到这条消息里');
  });

  it('不声称重试过: 终态也可能来自"已有产出所以不重投"', () => {
    // maker-core 的产出守卫会在 turn 已有 text / reasoning / tool 产出时**拒绝**自动
    // 重投并立刻透终态, 那时一次重试都没发生过; 接管条件不满足时同理
    // (review #844 codex P1)。渠道文案不得替它编造"重试多次"。
    const notice = overloadFailureNotice(
      'Selected model is at capacity. Please try a different model.',
    );
    expect(notice).not.toMatch(/重试多次|多次重试|重试.*仍未成功/);
    // 仍然要说清"现在是什么状况", 否则用户只看到一句无信息的失败。
    expect(notice).toContain('上游暂时没有可用容量');
  });

  it('非过载错误沿用原文(返回 null 让调用方不改写)', () => {
    expect(overloadFailureNotice('process exited with code 1')).toBeNull();
    expect(overloadFailureNotice('Request timed out', 504)).toBeNull();
  });

  it('结构化 codexErrorInfo 命中时不依赖文案措辞', () => {
    // 只认文案时, codex 改措辞会让这条终态说明退回裸英文原文推给渠道用户。
    const notice = overloadFailureNotice(
      'The upstream declined this request.',
      undefined,
      'serverOverloaded',
    );
    expect(notice).toContain('模型服务繁忙');
    expect(notice).toContain('在这里重发这条消息');
  });

  it('非过载的结构化 tag 不改写原文', () => {
    expect(overloadFailureNotice('stream gone', undefined, 'responseStreamDisconnected')).toBeNull();
  });
});

describe('terminalErrorText', () => {
  it('Codex 容量终态 → 本地化说明(定时转播卡与用户 turn 共用同一映射)', () => {
    // 三条渠道终态路径(handleTurnErrorAsync / finalizeTranspond / hook session-runner)
    // 必须口径一致: 之前转播路径自己 extractErrMessage 取原文, 重试耗尽时卡片会从
    // 「正在自动重试（N/M）」突然跳回英文原文(review #844 codex P1)。
    const text = terminalErrorText({
      message: 'Selected model is at capacity. Please try a different model.',
    });
    expect(text).toContain('模型服务繁忙');
    expect(text).toContain('在这里重发这条消息');
  });

  it('只有状态码带 529 时也命中(errorStatus 不能在取文案时被丢掉)', () => {
    // Anthropic 的 529 有时只体现在状态码上, message 里不含 529 字样。
    expect(terminalErrorText({ message: 'SDK API request failed', errorStatus: 529 })).toContain(
      '模型服务繁忙',
    );
  });

  it('结构化 codexErrorInfo 从 data 里被取出并透传(三条终态路径共用)', () => {
    const text = terminalErrorText({
      message: 'The upstream declined this request.',
      codexErrorInfo: 'serverOverloaded',
    });
    expect(text).toContain('模型服务繁忙');
  });

  it('非过载终态沿用上游原文', () => {
    expect(terminalErrorText({ message: 'process exited with code 1' })).toBe(
      'process exited with code 1',
    );
    expect(terminalErrorText({ message: 'Request timed out', errorStatus: 504 })).toBe(
      'Request timed out',
    );
  });

  it('形状异常时退回 String(data), 与被它取代的 extractErrMessage 逐字一致', () => {
    expect(terminalErrorText('at capacity')).toContain('模型服务繁忙');
    expect(terminalErrorText('boom')).toBe('boom');
    expect(terminalErrorText(null)).toBe('null');
    expect(terminalErrorText({})).toBe('[object Object]');
  });

  /**
   * Auto 档审阅器故障同样走非终止 error。渠道侧原来对这类一律静默 —— Slack /
   * Telegram 上的用户只看到工具接连被拒、没有原因(codex P1 of #1574)。
   */
  it('Auto 档审阅器不可用 → 渠道侧说明 + 可执行动作', () => {
    const notice = turnRetryNotice({
      message: '[AUTO_REVIEW_UNAVAILABLE] Auto-review could not reach a decision (network or '
        + 'service hiccup), so actions that need review are being handed to you to confirm.',
      isTerminal: false,
    });
    expect(notice).toContain('自动审批暂时无法给出判断');
    // 必须说清操作的去向 —— 现在是转交用户确认,不再是静默拒绝。
    expect(notice).toContain('转由你来确认');
    // 必须给出用户能做的事,否则等于只说"又失败了"。
    expect(notice).toContain('默认权限');
    // 不得把 [CODE] 前缀或英文原文推给渠道用户。
    expect(notice).not.toContain('AUTO_REVIEW_UNAVAILABLE');
    expect(notice).not.toContain('Auto-review could not');
  });

  it('确认卡没送到 → 渠道侧说明这次不是用户拒绝', () => {
    const notice = turnRetryNotice({
      message: '[AUTO_REVIEW_CONFIRM_UNDELIVERED] Automatic review was unavailable, and the '
        + 'confirmation request was not completed. This is not a user rejection.',
      isTerminal: false,
    });
    expect(notice).toContain('这次拒绝不是你点的');
    expect(notice).not.toContain('AUTO_REVIEW_CONFIRM_UNDELIVERED');
    expect(notice).not.toContain('not a user rejection');
  });

  it('其它带 bracket code 的非终止 error 仍保持静默', () => {
    // 只放开有明确渠道文案的那一条,不是所有 [CODE] 都外发。
    expect(turnRetryNotice({
      message: '[REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED] Local attachments are not accessible.',
    })).toBeNull();
  });

  it('message 为 undefined / null 时不得把字面量 "undefined" 给用户看', () => {
    // 判 key 是否存在('message' in record)会让 message: undefined 也走进去, String() 出
    // 字面量 "undefined"; 过载文案映射也会跟着取决于这个意外字符串(copilot 低置信提示)。
    expect(terminalErrorText({ message: undefined })).toBe('[object Object]');
    expect(terminalErrorText({ message: null })).toBe('[object Object]');
    // 值存在就照常取值(含非字符串)。
    expect(terminalErrorText({ message: 0 })).toBe('0');
    expect(terminalErrorText({ message: 'boom' })).toBe('boom');
  });
});
