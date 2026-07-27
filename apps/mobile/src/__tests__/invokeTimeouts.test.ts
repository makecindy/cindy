import { describe, expect, it } from 'vitest';
import { INVOKE_TIMEOUT_OVERRIDES_MS } from '@cindy/device-link';
import {
  MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS,
  MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS,
  resolveMobileInvokeTimeoutMs,
} from '@/device-link/invokeTimeouts';

describe('resolveMobileInvokeTimeoutMs', () => {
  it('mobile 精确表优先:media / 文件搜索 / 词典学习保住收紧前的 30s 窗口', () => {
    expect(resolveMobileInvokeTimeoutMs('device-link:media:fetch')).toBe(30_000);
    expect(resolveMobileInvokeTimeoutMs('file-browser:remote-op')).toBe(30_000);
    // 词典学习:桌面 advisor 的 managed refiner 单次尝试空闲窗 12s 且会换备选
    // profile 重试,合法执行可超 15s;15s 默认误超时会把后台学习计入熔断失败。
    expect(resolveMobileInvokeTimeoutMs('device-link:voice:dictionary-learning')).toBe(30_000);
    // 语音转写:桌面端 OSS 下载 + 批量网关转写,两段都无更短 deadline,中速网络
    // 合法可超 15s,连续几条误超时会错误打开设备级熔断。
    expect(resolveMobileInvokeTimeoutMs('device-link:voice:transcribe')).toBe(30_000);
    // fork:载入完整消息前缀 + SDK fork + 事务批量拷贝,大会话 15-30s;非幂等,
    // 误超时后桌面仍会建出新会话,重试会分叉重复副本。
    expect(resolveMobileInvokeTimeoutMs('maker:fork')).toBe(30_000);
    // rewind:commit:DB 读 + 线程回滚 + Git 回退 + SQLite 事务,非幂等——误超时
    // 后对话与文件已被回退,重试会作用在已变更的历史上。
    expect(resolveMobileInvokeTimeoutMs('maker:rewind:commit')).toBe(30_000);
    // context-usage:非运行中会话走 lazy-create(SSH 就绪等待 20s + 会话拉起)。
    expect(resolveMobileInvokeTimeoutMs('maker:get-context-usage')).toBe(30_000);
    // codex rate-limit 读/消耗:账号 app-server 冷启动无更短 deadline;reset
    // 有真实副作用,误超时后重试有重复扣减风险。
    expect(resolveMobileInvokeTimeoutMs('maker:usage:codex-rate-limits')).toBe(30_000);
    expect(resolveMobileInvokeTimeoutMs('maker:usage:codex-rate-limit-reset')).toBe(30_000);
    // send:接收前等 SSH 就绪(20s 窗口);非幂等,误超时重试会把消息发两遍。
    expect(resolveMobileInvokeTimeoutMs('maker:send')).toBe(30_000);
    // regenerate-title:OAuth 刷新(~10s)+ 标题请求自身 12s,合法总预算 ~22s。
    expect(resolveMobileInvokeTimeoutMs('maker:regenerate-title')).toBe(30_000);
    // create-session:冷启动 app-server / agent 拉起无更短 deadline;goal 路径
    // 无稳定客户端会话 id,误超时重试会建出第二个会话。
    expect(resolveMobileInvokeTimeoutMs('maker:create-session')).toBe(30_000);
    // goal set/resume:restoreSessionForGoal 同样 await createSession 重启持久化
    // agent;两者有真实副作用,误超时重试会改动/重启已在跑的 goal。
    expect(resolveMobileInvokeTimeoutMs('maker:goal:set')).toBe(30_000);
    expect(resolveMobileInvokeTimeoutMs('maker:goal:resume')).toBe(30_000);
    expect(MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS['device-link:media:fetch']).toBe(30_000);
  });

  it('maker:schedule:* 前缀整类放宽:桌面 handler 会等 scheduler 就绪(30s 上限)', () => {
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:list')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:list-runs')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:mark-run-read')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('其余通道回退协议契约表;无登记则 undefined(client 默认 15s)', () => {
    for (const [channel, ms] of Object.entries(INVOKE_TIMEOUT_OVERRIDES_MS)) {
      expect(resolveMobileInvokeTimeoutMs(channel)).toBe(ms);
    }
    expect(resolveMobileInvokeTimeoutMs('maker:get-capabilities')).toBe(
      INVOKE_TIMEOUT_OVERRIDES_MS['maker:get-capabilities'],
    );
  });
});
