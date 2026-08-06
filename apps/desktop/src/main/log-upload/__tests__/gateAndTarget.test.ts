/**
 * 授权闸与上报目标的锁（需求 §4.3 / §4.4 / §6）。
 *
 * 「未配置目标时不去读用户授权状态」「读取失败是 unknown 而不是 denied」这两条容易被后人
 * 顺手改掉，所以各有一条独立用例钉住。
 */
import { describe, expect, it, vi } from 'vitest';

import { evaluateGate, isManualUploadAvailable, type ConsentGateDeps } from '../consentGate';
import { buildTrackUrl } from '../logSink';
import { isTargetConfigured, resolveLogUploadTarget } from '../logUploadTarget';
import type { LogUploadTarget } from '../types';

function gate(overrides: Partial<ConsentGateDeps> = {}): ConsentGateDeps {
  return {
    isTargetConfigured: () => true,
    refreshFromDisk: () => undefined,
    readPrivacyConsentAccepted: () => true,
    readCrashAutoUploadEnabled: () => true,
    ...overrides,
  };
}

describe('evaluateGate', () => {
  it('手动上传：已配置 + 已同意 ⇒ 放行', () => {
    expect(evaluateGate(gate(), 'manual')).toEqual({ kind: 'allowed' });
  });

  it('手动上传不看崩溃开关（点击本身即这一次的意图）', () => {
    const deps = gate({ readCrashAutoUploadEnabled: () => false });
    expect(evaluateGate(deps, 'manual')).toEqual({ kind: 'allowed' });
  });

  it('未配置目标 ⇒ denied(not-configured)，且不去读授权状态', () => {
    const readConsent = vi.fn(() => true);
    const deps = gate({ isTargetConfigured: () => false, readPrivacyConsentAccepted: readConsent });
    expect(evaluateGate(deps, 'manual')).toEqual({ kind: 'denied', reason: 'not-configured' });
    // 功能整体关闭时不该去碰用户的持久状态。
    expect(readConsent).not.toHaveBeenCalled();
  });

  it('未同意隐私政策 ⇒ denied(no-consent)，三条路径都拦', () => {
    const deps = gate({ readPrivacyConsentAccepted: () => false });
    for (const reason of ['manual', 'crash-immediate', 'crash-backfill'] as const) {
      expect(evaluateGate(deps, reason)).toEqual({ kind: 'denied', reason: 'no-consent' });
    }
  });

  it('自动路径：崩溃开关关闭 ⇒ denied(crash-auto-off)', () => {
    const deps = gate({ readCrashAutoUploadEnabled: () => false });
    expect(evaluateGate(deps, 'crash-immediate')).toEqual({
      kind: 'denied',
      reason: 'crash-auto-off',
    });
    expect(evaluateGate(deps, 'crash-backfill')).toEqual({
      kind: 'denied',
      reason: 'crash-auto-off',
    });
  });

  it('每次判定都先现读盘（跨实例撤回授权必须立刻生效）', () => {
    const refresh = vi.fn();
    const deps = gate({ refreshFromDisk: refresh });
    evaluateGate(deps, 'manual');
    evaluateGate(deps, 'crash-backfill');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('读取抛异常 ⇒ unknown（不是 denied：不能用一次读取失败永久丢掉崩溃现场）', () => {
    const deps = gate({
      readPrivacyConsentAccepted: () => {
        throw new Error('userData not ready');
      },
    });
    expect(evaluateGate(deps, 'crash-backfill')).toEqual({ kind: 'unknown' });
  });

  it('现读盘本身抛异常 ⇒ unknown', () => {
    const deps = gate({
      refreshFromDisk: () => {
        throw new Error('EPERM');
      },
    });
    expect(evaluateGate(deps, 'manual')).toEqual({ kind: 'unknown' });
  });

  /**
   * 2026-08-04 review P2 的回归锁：真实依赖（两个 `createOverrideSettingsFile` store）读到坏
   * JSON 时会**吞掉异常返回默认值**，于是「文件损坏」与「用户明确没同意 / 明确关掉开关」在
   * 返回值上无法区分。闸把前者判成 denied 的后果是 `runUpload` 清空待补传标记——一次设置文件
   * 读取故障就永久丢掉崩溃现场。接线层（`index.ts` 的 `gateDeps`）因此必须在探到「文件在但
   * 解析不出来」时抛出；这里锁住「抛出 ⇒ unknown ⇒ 标记保留」这条链的前半段。
   */
  it.each([
    ['同意记录不可读', { readPrivacyConsentAccepted: () => { throw new Error('unreadable'); } }],
    ['崩溃开关记录不可读', { readCrashAutoUploadEnabled: () => { throw new Error('unreadable'); } }],
  ])('⚠️ %s ⇒ unknown，绝不能是 denied（denied 会清空崩溃标记）', (_case, override) => {
    const verdict = evaluateGate(gate(override as Partial<ConsentGateDeps>), 'crash-backfill');
    expect(verdict).toEqual({ kind: 'unknown' });
    expect(verdict.kind).not.toBe('denied');
  });

  /**
   * 上一条的反面（2026-08-04 review P2）：把「读不出来 ⇒ unknown」做进闸之后，手动上传
   * 也会被崩溃开关的读取故障牵连——`unknown` 在 IPC 层映射成 PRIVACY_CONSENT_REQUIRED，
   * 于是「崩溃自动上传偏好文件损坏」把用户主动点的上传一并堵掉，恰好是最需要交日志的时候。
   * 手动路径的放行条件里本来就没有这个开关，所以**连读都不该读**。
   */
  it('⚠️ 手动路径不读崩溃开关：开关记录不可读也照样放行', () => {
    const read = vi.fn<() => boolean>(() => {
      throw new Error('unreadable');
    });
    const deps = gate({ readCrashAutoUploadEnabled: read });
    expect(evaluateGate(deps, 'manual')).toEqual({ kind: 'allowed' });
    expect(read).not.toHaveBeenCalled();
  });

  it('手动路径连开关本身都不看：关着也放行', () => {
    const read = vi.fn<() => boolean>(() => false);
    expect(evaluateGate(gate({ readCrashAutoUploadEnabled: read }), 'manual')).toEqual({
      kind: 'allowed',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('未同意时不读崩溃开关（结论已定，不必再碰第二份文件）', () => {
    const read = vi.fn<() => boolean>(() => true);
    const deps = gate({ readPrivacyConsentAccepted: () => false, readCrashAutoUploadEnabled: read });
    expect(evaluateGate(deps, 'crash-backfill')).toEqual({ kind: 'denied', reason: 'no-consent' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('isManualUploadAvailable', () => {
  it('已配置 + 已同意 ⇒ true', () => {
    expect(isManualUploadAvailable(gate())).toBe(true);
  });

  it('任一不满足 ⇒ false', () => {
    expect(isManualUploadAvailable(gate({ isTargetConfigured: () => false }))).toBe(false);
    expect(isManualUploadAvailable(gate({ readPrivacyConsentAccepted: () => false }))).toBe(false);
  });
});

describe('isTargetConfigured', () => {
  const full: LogUploadTarget = { project: 'p', logstore: 'l', endpointHost: 'h.example.com' };

  it('有目标 ⇒ true', () => {
    expect(isTargetConfigured(full)).toBe(true);
  });

  it('null ⇒ false（未配置 = 功能整体关闭）', () => {
    expect(isTargetConfigured(null)).toBe(false);
  });
});

/**
 * 构建期注入的解析与区域交叉校验。
 *
 * 注入是文本替换（`vite.main.config.ts` 的 define），链路上任何一环出错的表现都是**静默**的
 * ——包发出去、功能悄悄关掉，或者更糟：往另一个区域的 logstore 写。所以这一层的每种坏形态都
 * 必须落在「返回 null」而不是「照用」。
 */
describe('resolveLogUploadTarget（构建期注入）', () => {
  const raw = JSON.stringify({
    region: 'cn',
    project: 'cindy-sh-prod',
    logstore: 'cindy-sh-prod-client-log',
    endpointHost: 'cn-shanghai.log.aliyuncs.com',
  });

  it('注入串与本构建区域一致 ⇒ 取用', () => {
    expect(resolveLogUploadTarget({ region: 'cn', raw })).toEqual({
      project: 'cindy-sh-prod',
      logstore: 'cindy-sh-prod-client-log',
      endpointHost: 'cn-shanghai.log.aliyuncs.com',
    });
  });

  it('拼出的写入地址逐字符正确（host 形态写错是静默失败，值得钉死）', () => {
    expect(buildTrackUrl(resolveLogUploadTarget({ region: 'cn', raw })!)).toBe(
      'https://cindy-sh-prod.cn-shanghai.log.aliyuncs.com/logstores/cindy-sh-prod-client-log/track',
    );
  });

  it('产出对象只有三个字段（region 只用于校验，不进上报目标）', () => {
    expect(Object.keys(resolveLogUploadTarget({ region: 'cn', raw })!).sort()).toEqual([
      'endpointHost',
      'logstore',
      'project',
    ]);
  });

  it('⚠️ 注入的 region 与本构建区域不一致 ⇒ null（宁可不上报，也不往可能错误的 logstore 写）', () => {
    expect(resolveLogUploadTarget({ region: 'global', raw })).toBeNull();
    expect(resolveLogUploadTarget({ region: 'dev', raw })).toBeNull();
  });

  it.each([
    ['未注入（空串）', ''],
    ['纯空白', '   '],
    ['不是 JSON', 'not-json'],
    ['JSON 数组', '[]'],
    ['JSON 标量', '"x"'],
    ['null', 'null'],
  ])('%s ⇒ null（功能整体关闭，不抛）', (_case, value) => {
    expect(resolveLogUploadTarget({ region: 'cn', raw: value })).toBeNull();
  });

  it.each([
    ['缺 region', { project: 'p', logstore: 'l', endpointHost: 'h.example.com' }],
    ['缺 project', { region: 'cn', logstore: 'l', endpointHost: 'h.example.com' }],
    ['缺 logstore', { region: 'cn', project: 'p', endpointHost: 'h.example.com' }],
    ['缺 endpointHost', { region: 'cn', project: 'p', logstore: 'l' }],
    ['project 空串', { region: 'cn', project: '', logstore: 'l', endpointHost: 'h.example.com' }],
    ['字段类型不对', { region: 'cn', project: 1, logstore: 'l', endpointHost: 'h.example.com' }],
  ])('%s ⇒ null', (_case, payload) => {
    expect(resolveLogUploadTarget({ region: 'cn', raw: JSON.stringify(payload) })).toBeNull();
  });

  it.each([
    ['带协议', 'https://cn-shanghai.log.aliyuncs.com'],
    ['带路径', 'cn-shanghai.log.aliyuncs.com/logstores'],
    ['带 project 前缀', 'cindy-sh-prod.cn-shanghai.log.aliyuncs.com'],
    // ⚠️ 2026-08-04 review P1:合法形状的**任意域名**必须也判 null,否则绕过 loadLogUploadTargets
    // 的注入(dev .env / 异常打包)能把日志改投他人域(buildTrackUrl → https://<project>.<域>/)。
    ['任意域名 evil.com', 'evil.com'],
    ['SLS 域名后缀攻击', 'cn-shanghai.log.aliyuncs.com.evil.com'],
    ['近似域名', 'cn-shanghai.log.aliyuncs.net'],
    ['多一级子域伪装', 'cn-shanghai.log.aliyuncs.com.'],
  ])('endpointHost %s ⇒ null（非 SLS 接入域名一律 fail closed）', (_case, host) => {
    const payload = JSON.stringify({
      region: 'cn',
      project: 'cindy-sh-prod',
      logstore: 'cindy-sh-prod-client-log',
      endpointHost: host,
    });
    expect(resolveLogUploadTarget({ region: 'cn', raw: payload })).toBeNull();
  });

  it('合法 SLS 接入域名放行（区域代号 + .log.aliyuncs.com）', () => {
    for (const host of ['cn-shanghai.log.aliyuncs.com', 'ap-southeast-1.log.aliyuncs.com']) {
      const payload = JSON.stringify({
        region: 'cn',
        project: 'p',
        logstore: 'l',
        endpointHost: host,
      });
      expect(resolveLogUploadTarget({ region: 'cn', raw: payload })?.endpointHost).toBe(host);
    }
  });

  // ⚠️ 2026-08-06 review P1:project / logstore 也必须钉死在 SLS 名字集内。project 拼在
  // buildTrackUrl 的**子域**位置(https://<project>.<endpointHost>/...),含 `.`/`/` 的 project
  // 能把 host 顶成任意域,endpointHost 校验通过也照样改投他人域;logstore 含 `/` 能改写请求路径。
  it.each([
    ['project 改投域名 evil.com/p', 'evil.com/p', 'l'],
    ['project 含点', 'evil.com', 'l'],
    ['project 含斜杠', 'p/x', 'l'],
    ['project 大写(非 SLS 名)', 'Cindy', 'l'],
    ['logstore 含斜杠改写路径', 'p', 'l/../track'],
    ['logstore 含点', 'p', 'a.b'],
    ['logstore 空白细工', 'p', 'l l'],
  ])('%s ⇒ null（project/logstore 非 SLS 名一律 fail closed）', (_case, project, logstore) => {
    const payload = JSON.stringify({
      region: 'cn',
      project,
      logstore,
      endpointHost: 'cn-shanghai.log.aliyuncs.com',
    });
    expect(resolveLogUploadTarget({ region: 'cn', raw: payload })).toBeNull();
  });

  it('未注入时（vitest / dev server 的真实情形）默认读环境变量并判未配置', () => {
    const saved = process.env.XDT_LOG_UPLOAD_TARGET;
    delete process.env.XDT_LOG_UPLOAD_TARGET;
    try {
      expect(resolveLogUploadTarget({ region: 'cn' })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.XDT_LOG_UPLOAD_TARGET = saved;
    }
  });
});
