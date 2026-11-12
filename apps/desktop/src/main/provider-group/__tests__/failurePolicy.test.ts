/**
 * 供应商组「这次失败怎么办」的唯一判定(provider-groups.md §6.1「怎么判断换不换」)：默认换，只有换到哪台都一样、
 * 或不是那台电脑的问题时不换。下面按「故障 × 阶段」列出验收表，所有路径(新任务启动、运行中、换过去、分享的人
 * 中转)都问这一个判定。
 */
import { SESSION_CLOSED_MID_TURN_MESSAGE } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import {
  decideProviderGroupFailure,
  describeProviderGroupFailure,
  PROVIDER_GROUP_SUPERSEDED_ERROR,
  PROVIDER_GROUP_UNAVAILABLE_ERROR,
  providerGroupFailureSignals,
  providerGroupUnavailableError,
  type ProviderGroupFailurePhase,
} from '../failurePolicy';
import type { InterruptedTurnErrorSignals } from '../../maker-ipc/interruptedTurnAutoResume';

const switchTo = (cause: string, connection: 'lost' | 'check' | null = null) => ({
  action: 'switch',
  cause,
  connection,
  cool: cause === 'usage-limit' || cause === 'auth' || cause === 'overload',
});
const stay = (why: string) => ({ action: 'stay', why });

const PHASES: ProviderGroupFailurePhase[] = ['start', 'run', 'target'];

describe('decideProviderGroupFailure — the account on that computer', () => {
  it.each<[string, InterruptedTurnErrorSignals, ReturnType<typeof switchTo>]>([
    ['usage limit (Claude tag)', { sdkError: 'rate_limit' }, switchTo('usage-limit')],
    ['usage limit (Codex tag)', { codexErrorInfo: 'usageLimitExceeded' }, switchTo('usage-limit')],
    ['billing depleted', { sdkError: 'billing_error' }, switchTo('usage-limit')],
    ['HTTP 429', { errorStatus: 429, message: 'rate limited' }, switchTo('usage-limit')],
    ['signed out (tag)', { sdkError: 'authentication_failed' }, switchTo('auth')],
    ['signed out (401)', { errorStatus: 401 }, switchTo('auth')],
    ['signed out (Codex)', { codexErrorInfo: 'unauthorized' }, switchTo('auth')],
    ['invalid API key text', { message: 'Invalid API key provided' }, switchTo('auth')],
    ['agent not authenticated at start', { message: 'Claude Code is not authenticated' }, switchTo('auth')],
    ['overloaded (529)', { errorStatus: 529 }, switchTo('overload')],
    ['overloaded (Codex)', { codexErrorInfo: 'serverOverloaded' }, switchTo('overload')],
  ])('%s → switch and record it in the group (cool)', (_name, signals, expected) => {
    for (const phase of PHASES) expect(decideProviderGroupFailure(signals, phase)).toEqual(expected);
  });
});

describe('decideProviderGroupFailure — that computer cannot be reached or cannot take the task', () => {
  it.each<[string, InterruptedTurnErrorSignals, ReturnType<typeof switchTo>]>([
    // 只是连接断了：先等它恢复，现读第一次就连得上算恢复。
    ['device unreachable', { message: '[REMOTE_AGENT_DEVICE_UNREACHABLE] unreachable' }, switchTo('unavailable', 'lost')],
    ['Cindy restarted there (expired)', { message: '[REMOTE_AGENT_EXPIRED] session expired' }, switchTo('unavailable', 'lost')],
    ['Cindy restarted there (not found)', { message: '[REMOTE_AGENT_NOT_FOUND] no such session' }, switchTo('unavailable', 'lost')],
    // 可能连不上：现读一次，确实连不上才等。
    ['reader gave up (2 minutes)', {
      message: '[REMOTE_AGENT_UNAVAILABLE] The computer running this agent is unreachable.',
      reason: 'remote_agent_closed',
    }, switchTo('unavailable', 'check')],
    ['agent there stopped unexpectedly', { reason: 'remote_agent_closed', message: 'stream broke' }, switchTo('unavailable', 'check')],
    ['shared computer unreachable', { message: '[REMOTE_AGENT_SHARE_UNAVAILABLE] not available' }, switchTo('unavailable', 'check')],
    ['too busy', { message: '[REMOTE_AGENT_BUSY] too many tasks' }, switchTo('unavailable', 'check')],
    // 那台本身现在不能接：不等，直接换。
    ['remote invocation turned off', { message: '[REMOTE_AGENT_PROVIDER_NOT_ALLOWED] not allowed' }, switchTo('unavailable')],
    ['model not offered there', { message: '[REMOTE_AGENT_MODEL_UNAVAILABLE] no such model' }, switchTo('unavailable')],
    ['share paused', { message: '[REMOTE_AGENT_SHARE_PAUSED] paused' }, switchTo('unavailable')],
    ['share removed', { message: '[REMOTE_AGENT_SHARE_REMOVED] removed' }, switchTo('unavailable')],
    ['account changed there', { message: '[REMOTE_AGENT_ACCOUNT_CHANGED] changed' }, switchTo('unavailable')],
    ['Cindy too old there', { message: '[REMOTE_AGENT_PEER_TOO_OLD] too old' }, switchTo('unavailable')],
    ['agent not installed there', { message: '[REMOTE_AGENT_UNSUPPORTED] codex is not available on this computer' }, switchTo('unavailable')],
    ['wrapped code in the middle', { message: 'open failed: [REMOTE_AGENT_DEVICE_UNREACHABLE] gone' }, switchTo('unavailable', 'lost')],
  ])('%s → switch (no cooling)', (_name, signals, expected) => {
    for (const phase of PHASES) expect(decideProviderGroupFailure(signals, phase)).toEqual(expected);
  });
});

describe('decideProviderGroupFailure — everything else is that computer’s problem (default: switch)', () => {
  it.each<[string, InterruptedTurnErrorSignals]>([
    ['agent ended mid-turn', {
      message: 'Session event loop stopped unexpectedly without a terminal event',
      reason: 'session_event_loop_crashed',
    }],
    ['agent event loop crashed', { message: 'Session event loop stopped unexpectedly: boom', reason: 'session_event_loop_crashed' }],
    ['no error details', { message: '任务执行失败（模型未返回错误详情）。', reason: 'turn-failed' }],
    ['502 after retries', { message: 'API Error: 502 Bad Gateway', errorStatus: 502 }],
    ['503 after retries', { message: 'Service Unavailable', errorStatus: 503 }],
    ['stream cut after retries', { message: 'API Error: Connection closed mid-response.', sdkError: 'server_error' }],
    ['network timeout after retries', { message: 'Request timed out' }],
    ['stalled turn after retries', { message: 'no events', reason: 'turn_no_event_timeout' }],
    ['Codex reconnect stalled', { message: 'stalled', reason: 'codex_reconnect_stalled' }],
    ['SDK stream crashed', { message: 'crash', reason: 'sdk_stream_crashed' }],
    ['unknown agent start error', { message: 'spawn ENOENT' }],
  ])('%s → switch with cause failed, not recorded in the group', (_name, signals) => {
    for (const phase of PHASES) expect(decideProviderGroupFailure(signals, phase)).toEqual(switchTo('failed'));
  });
});

describe('decideProviderGroupFailure — any computer would fail the same way (stay)', () => {
  it.each<[string, InterruptedTurnErrorSignals, string]>([
    ['prompt too long', { sdkError: 'invalid_request', message: 'prompt is too long' }, 'context'],
    ['context overflow reason', { reason: 'context-overflow', message: 'too long' }, 'context'],
    ['Codex context window', { codexErrorInfo: 'contextWindowExceeded', message: 'x' }, 'context'],
    ['Codex history oversized', { reason: 'codex_history_oversized', message: 'x' }, 'context'],
    ['output limit', { reason: 'output-limit', message: 'x' }, 'context'],
    ['Claude output limit without a reason or message', { sdkError: 'max_output_tokens' }, 'context'],
    ['Claude output limit with opaque terminal wording', { sdkError: 'max_output_tokens', message: 'SDK request failed', reason: 'api_error' }, 'context'],
    ['invalid request', { sdkError: 'invalid_request', message: 'messages: field required' }, 'invalid-request'],
    ['HTTP 400', { errorStatus: 400, message: 'bad request' }, 'invalid-request'],
    ['HTTP 413', { errorStatus: 413, message: 'too large' }, 'invalid-request'],
    ['Codex bad request', { codexErrorInfo: 'badRequest', message: 'x' }, 'invalid-request'],
    ['content policy', { codexErrorInfo: 'cyberPolicy', message: 'x' }, 'policy'],
    ['tool loop', { reason: 'tool_use_loop_detected', message: 'loop' }, 'tool-loop'],
    ['permission denied by user', { message: 'Permission denied by user' }, 'user'],
    ['tool execution failed', { reason: 'turn-failed', message: 'Tool execution failed' }, 'local'],
    ['cancelled before dispatch', { reason: 'cancelled-before-dispatch', message: 'x' }, 'user'],
  ])('%s → stay (%s)', (_name, signals, why) => {
    for (const phase of PHASES) expect(decideProviderGroupFailure(signals, phase)).toEqual(stay(why));
  });

  it('does not count usage limits wrapped as invalid_request as a request problem', () => {
    expect(decideProviderGroupFailure({ sdkError: 'invalid_request', errorStatus: 429, message: 'rate limited' }, 'run'))
      .toEqual(switchTo('usage-limit'));
  });
});

describe('decideProviderGroupFailure — not that computer’s problem (stay)', () => {
  it('this computer closed the running session itself (Library sync, setting change, …)', () => {
    expect(decideProviderGroupFailure({ message: SESSION_CLOSED_MID_TURN_MESSAGE, reason: 'session_event_loop_crashed' }, 'run'))
      .toEqual(stay('local'));
  });

  it('the user took over during the switch', () => {
    for (const phase of PHASES) {
      expect(decideProviderGroupFailure({ message: PROVIDER_GROUP_SUPERSEDED_ERROR }, phase)).toEqual(stay('user'));
    }
  });

  it('the whole group is unavailable', () => {
    expect(decideProviderGroupFailure({ message: PROVIDER_GROUP_UNAVAILABLE_ERROR }, 'run')).toEqual(stay('group-unavailable'));
    const error = providerGroupUnavailableError({ usageLimit: { resetAtMs: 5_000_000 } });
    for (const phase of PHASES) {
      expect(decideProviderGroupFailure({ message: error.message }, phase)).toEqual(stay('group-unavailable'));
    }
  });

  it('the task itself cannot be switched right now (start / target only)', () => {
    for (const code of ['SESSION_RUNNING', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNSUPPORTED_CAPABILITY']) {
      const signals = { message: `[${code}] nope` };
      expect(decideProviderGroupFailure(signals, 'start')).toEqual(stay('task-state'));
      expect(decideProviderGroupFailure(signals, 'target')).toEqual(stay('task-state'));
    }
  });

  it('nothing to decide on', () => {
    expect(decideProviderGroupFailure(undefined, 'run')).toEqual(stay('no-signal'));
    expect(decideProviderGroupFailure({}, 'run')).toEqual(stay('no-signal'));
  });
});

describe('providerGroupFailureSignals', () => {
  it('reads thrown errors and plain records the same way', () => {
    expect(providerGroupFailureSignals(new Error('[REMOTE_AGENT_BUSY] x'))).toEqual({ message: '[REMOTE_AGENT_BUSY] x' });
    expect(providerGroupFailureSignals('boom')).toEqual({ message: 'boom' });
    expect(providerGroupFailureSignals({ sdkError: 'rate_limit' })).toEqual({ sdkError: 'rate_limit' });
    expect(providerGroupFailureSignals(null)).toEqual({});
  });
});

describe('describeProviderGroupFailure', () => {
  it('logs codes and structured fields only, never the error text', () => {
    const signals = { message: '[REMOTE_AGENT_BUSY] secret prompt text', reason: 'remote_agent_closed', errorStatus: 503 };
    const described = describeProviderGroupFailure(signals, decideProviderGroupFailure(signals, 'run'));
    expect(described).toEqual({
      action: 'switch', cause: 'unavailable', connection: 'check', cool: false,
      code: 'REMOTE_AGENT_BUSY', reason: 'remote_agent_closed', errorStatus: 503,
    });
    expect(JSON.stringify(described)).not.toContain('secret');
  });
});
