import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_LINK_MEDIA_FETCH_CHANNEL,
  DEVICE_LINK_VOICE_CREDENTIAL_SYNC_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL,
  DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL,
  MOBILE_REMOTE_INVOKE_CHANNELS,
  connectionIssueHint,
  connectionIssueTitle,
  describeAgentAuthError,
  describeRemoteError,
  formatRemoteError,
  humanizeRemoteError,
  isAccessRevokedRemoteError,
  isDeviceUnresponsiveRemoteError,
  isPreconditionFailedRemoteError,
  isMobileRemoteInvokeChannel,
  isTransientRemoteError,
  relayStatusHint,
  relayStatusLabel,
  withTransientRemoteRetry,
} from '../deviceLinkContract.js';

const noSleep = async () => {};

describe('device-link shared contract', () => {
  it('documents mobile remote invoke channels and media special channels', () => {
    expect(DEVICE_LINK_MEDIA_FETCH_CHANNEL).toBe('device-link:media:fetch');
    expect(DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL).toBe('device-link:voice:transcribe');
    expect(DEVICE_LINK_VOICE_CREDENTIAL_SYNC_CHANNEL).toBe('device-link:voice:credential-sync');
    expect(DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL).toBe('device-link:voice:dictionary-learning');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:send');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:switch-session-agent');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:get-session-agent-switch-intent');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:input:compact');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('local-db:messages:around-client-id');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:message:delete');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:schedule:create-from-template');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:schedule:delete-run');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:usage:codex-rate-limits');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('maker:usage:codex-rate-limit-reset');
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).not.toContain(DEVICE_LINK_VOICE_CREDENTIAL_SYNC_CHANNEL);
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain(DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL);
    expect(MOBILE_REMOTE_INVOKE_CHANNELS).toContain('text-file:read-preview');
    expect(isMobileRemoteInvokeChannel('maker:send')).toBe(true);
    expect(isMobileRemoteInvokeChannel('auth:logout')).toBe(false);
  });

  it('labels relay status and maps remote errors to actionable copy', () => {
    expect(relayStatusLabel('online')).toBe('Relay 已连接');
    expect(relayStatusHint('online', new Date(2026, 0, 1, 3, 4, 5).getTime())).toBe('上次同步 03:04:05');
    expect(relayStatusHint('connecting', null)).toContain('自动重新订阅');

    expect(describeRemoteError('[REMOTE_DISABLED] disabled')).toContain('关闭允许远程控制');
    expect(describeRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x'")).toContain('版本不支持');
    expect(describeRemoteError('[ACCESS_REVOKED] revoked')).toContain('撤销手机访问权限');
    expect(describeRemoteError('[NOT_CONNECTED] offline')).toContain('稍后重新同步');
    expect(describeRemoteError('[VERSION_MISMATCH] server v2 client v1')).toContain('升级 App');
    expect(describeRemoteError('[PAYLOAD_TOO_LARGE] frame exceeds limit')).toContain('内容过大');
    expect(describeRemoteError('[MEDIA_FETCH_FAILED] oss upload failed')).toContain('获取电脑端文件失败');
    expect(describeRemoteError('[VOICE_TRANSCRIBE_FAILED] asr error')).toContain('语音转写失败');
    expect(describeRemoteError('[LINK_NOT_OPEN] no link')).toContain('控制链路已断开');
    expect(describeRemoteError('[PRECONDITION_FAILED] OFFER_EXPIRED: expired')).toContain('重新确认');
    expect(describeRemoteError('[PRECONDITION_FAILED] ACCOUNT_CHANGED: changed')).toContain('账号或工作区');
    expect(describeRemoteError('[INTERNAL] relay crashed')).toContain('远程调用失败');
    expect(describeRemoteError('[INTERNAL] relay crashed')).toContain('[INTERNAL] relay crashed');
    expect(describeRemoteError('unknown failure')).toBe('unknown failure');
  });

  it('detects structured and encoded precondition failures', () => {
    expect(isPreconditionFailedRemoteError(
      Object.assign(new Error('offer expired'), { code: 'PRECONDITION_FAILED' }),
    )).toBe(true);
    expect(isPreconditionFailedRemoteError(
      new Error('[PRECONDITION_FAILED] OFFER_EXPIRED: refresh usage'),
    )).toBe(true);
    expect(isPreconditionFailedRemoteError(new Error('[INTERNAL] failed'))).toBe(false);
  });

  it('maps agent not-authenticated errors to guidance copy', () => {
    // maker-core 鉴权门禁的固定 message 模板:`<agentKind> not authenticated: <reason>`
    expect(describeAgentAuthError('claude-code not authenticated: no_key'))
      .toContain('还没有配置可用的 API Key');
    expect(describeAgentAuthError('claude-code not authenticated: no_key'))
      .toContain('设置 → 模型供应商');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).toContain('Cindy');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).not.toContain('XDMaker');
    expect(describeAgentAuthError('claude-code not authenticated: no_key')).toContain('Claude');
    expect(describeAgentAuthError('codex not authenticated: no_credentials'))
      .toContain('尚未登录 Codex');
    expect(describeAgentAuthError('claude-code not authenticated: no_oauth')).toContain('账号授权');
    expect(describeAgentAuthError('claude-code not authenticated: no_encryption')).toContain('安全存储');
    expect(describeAgentAuthError('claude-code not authenticated: proxy_not_ready')).toContain('稍候重试');
    // 动态 reason(OAuth 被服务端作废等):按登录失效引导,原始 reason 附在句尾
    expect(describeAgentAuthError('codex not authenticated: oauth_invalidated_refresh'))
      .toContain('（oauth_invalidated_refresh）');
    // 容忍 formatRemoteError / throwIpcError 加的 `[CODE] ` 前缀
    expect(describeAgentAuthError('[IPC_ERROR] claude-code not authenticated: no_key'))
      .toContain('API Key');
    // 非鉴权错误不拦截
    expect(describeAgentAuthError('unknown failure')).toBeNull();
    expect(describeAgentAuthError('')).toBeNull();
    expect(describeAgentAuthError(null)).toBeNull();
    // describeRemoteError 走同一映射
    expect(describeRemoteError('claude-code not authenticated: no_key')).toContain('API Key');
  });

  it('maps connection issue kinds to actionable copy', () => {
    expect(connectionIssueTitle('auth-failed')).toBe('登录已失效');
    expect(connectionIssueHint('auth-failed')).toContain('重新登录');
    expect(connectionIssueTitle('replaced')).toContain('顶替');
    expect(connectionIssueHint('too-many-connections')).toContain('断开其它设备');
    expect(connectionIssueHint('version-mismatch')).toContain('升级到最新版本');
  });

  it('preserves structured remote error codes and access revoked classification', () => {
    expect(formatRemoteError(Object.assign(new Error('access revoked by target device'), { code: 'ACCESS_REVOKED' })))
      .toBe('[ACCESS_REVOKED] access revoked by target device');
    expect(formatRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' })))
      .toBe('[REMOTE_DISABLED] remote disabled');
    expect(formatRemoteError(new Error('[NOT_CONNECTED] offline'))).toBe('[NOT_CONNECTED] offline');

    expect(isAccessRevokedRemoteError(Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' }))).toBe(true);
    expect(isAccessRevokedRemoteError(new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'))).toBe(true);
    expect(isAccessRevokedRemoteError(Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }))).toBe(false);
  });

  it('humanizes unknown errors for user-facing alerts', () => {
    // 结构化 code(DeviceLinkError 形态)→ 人话映射,不透出原始 `[CODE] message`
    expect(humanizeRemoteError(Object.assign(new Error('not online within 1500ms'), { code: 'NOT_CONNECTED' })))
      .toBe('网络或被控端暂时不可用，可以稍后重新同步。');
    expect(humanizeRemoteError(Object.assign(new Error('revoked'), { code: 'ACCESS_REVOKED' })))
      .toContain('撤销手机访问权限');
    // 识别不了的错误原文透出(含普通 Error 与非 Error 值)
    expect(humanizeRemoteError(new Error('找不到这个会话所属电脑，请重新同步后再试。')))
      .toBe('找不到这个会话所属电脑，请重新同步后再试。');
    expect(humanizeRemoteError('plain failure')).toBe('plain failure');
  });

  it('classifies transient errors and retries only those failures', async () => {
    expect(isTransientRemoteError(new Error('DbClient not ready'))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('client is not ready'), { code: 'NOT_CONNECTED' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }))).toBe(true);
    expect(isTransientRemoteError('[DEVICE_LINK_TIMEOUT] no result')).toBe(true);
    // HTTP 层弱网错误(超时 / 离线 / RN 原生 fetch 原文)同属瞬时,必须可重试
    expect(isTransientRemoteError(Object.assign(new Error('请求超时，请稍后重试'), { code: 'REQUEST_TIMEOUT' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('网络连接不可用'), { code: 'NETWORK_UNAVAILABLE' }))).toBe(true);
    expect(isTransientRemoteError(new TypeError('Network request failed'))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' }))).toBe(false);
    expect(isTransientRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x' not allowed")).toBe(false);
    expect(isTransientRemoteError(new Error('unexpected'))).toBe(false);
    // 熔断快速失败必须是 permanent:归为瞬时会让 withTransientRemoteRetry 把
    // 本地直拒再重试 6 次,熔断等于白做。code 与 message 两种形态都要拦住。
    expect(isTransientRemoteError(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    )).toBe(false);
    expect(isTransientRemoteError('[DEVICE_UNRESPONSIVE] target device dev-1 is unresponsive')).toBe(false);

    const op = vi.fn()
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockRejectedValueOnce(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }))
      .mockResolvedValueOnce('ok');

    await expect(withTransientRemoteRetry(op, { sleep: noSleep })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);

    const permanent = vi.fn().mockRejectedValue(new Error('[REMOTE_DISABLED] remote control disabled'));
    await expect(withTransientRemoteRetry(permanent, { sleep: noSleep })).rejects.toThrow('remote control disabled');
    expect(permanent).toHaveBeenCalledTimes(1);

    // 熔断快速失败不重试:一次上抛,让调用方走降级路径
    const unresponsive = vi.fn().mockRejectedValue(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    );
    await expect(withTransientRemoteRetry(unresponsive, { sleep: noSleep })).rejects.toThrow('unresponsive');
    expect(unresponsive).toHaveBeenCalledTimes(1);
  });

  it('recognizes device-unresponsive breaker fast-fails and maps them to readable copy', () => {
    expect(isDeviceUnresponsiveRemoteError(
      Object.assign(new Error('target device dev-1 is unresponsive (circuit open)'), { code: 'DEVICE_UNRESPONSIVE' }),
    )).toBe(true);
    expect(isDeviceUnresponsiveRemoteError('[DEVICE_UNRESPONSIVE] target device dev-1 is unresponsive')).toBe(true);
    expect(isDeviceUnresponsiveRemoteError(new Error('[DEVICE_UNRESPONSIVE] fast fail'))).toBe(true);
    expect(isDeviceUnresponsiveRemoteError(new Error('unexpected'))).toBe(false);
    expect(isDeviceUnresponsiveRemoteError(Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' }))).toBe(false);
    expect(describeRemoteError('[DEVICE_UNRESPONSIVE] target device dev-1 is unresponsive'))
      .toBe('电脑端未响应，正在自动重试，请稍后再试。');
  });
});
