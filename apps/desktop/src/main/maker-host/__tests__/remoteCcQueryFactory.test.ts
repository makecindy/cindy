/**
 * remoteCcQueryFactory (maker-host/index.ts) 的结构性回归断言。
 *
 * maker-host/index.ts 是巨型组装函数, 闭包逻辑难以单测; 这里用源码结构
 * 断言守住两条 P1 回归 (与 makerSendToSessionOrdering.test.ts 同一模式):
 *
 *  1. race-2: openCcManagerSession 失败时必须调 mcpCleanup() 再 rethrow —
 *     否则 buildCcRemoteHttpMcpServers 注册的 per-session ctx / forward
 *     intent 残留到同 session 下一次重建或应用退出。
 *  2. remoteQuery.close 必须先 mcpCleanup 再 dispose (query close 注销
 *     session ctx; detach 不清, 重连时 factory 重新注册)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'index.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const ccManagerClientSource = readFileSync(
  resolve(__dirname, '..', 'cc-manager-client.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('remoteCcQueryFactory cleanup wiring', () => {
  it('finalizes OAuth Auto after MCP injection and before opening the remote query', () => {
    const injection = source.indexOf('mutableParams.mcpServers =');
    const finalize = source.indexOf(
      'routeInjectedRemoteMcpApprovalsThroughCindy(startParams, injectedServerCount)',
      injection,
    );
    const openCall = source.indexOf('return await openCcManagerSession({', finalize);

    expect(injection).toBeGreaterThan(-1);
    expect(finalize).toBeGreaterThan(injection);
    expect(openCall).toBeGreaterThan(finalize);
  });

  it('calls mcpCleanup before rethrowing when openCcManagerSession fails', () => {
    const openCall = source.indexOf('return await openCcManagerSession({');
    expect(openCall).toBeGreaterThan(-1);
    const cleanup = source.indexOf('mcpCleanup();', openCall);
    const rethrow = source.indexOf('throw err;', openCall);
    expect(cleanup).toBeGreaterThan(openCall);
    expect(rethrow).toBeGreaterThan(cleanup);
  });

  it('runs mcpCleanup before dispose on remoteQuery.close', () => {
    const disposeFn = source.indexOf('const disposeWithMcpCleanup = async');
    expect(disposeFn).toBeGreaterThan(-1);
    const cleanup = source.indexOf('mcpCleanup();', disposeFn);
    const dispose = source.indexOf('await dispose();', disposeFn);
    expect(cleanup).toBeGreaterThan(disposeFn);
    expect(dispose).toBeGreaterThan(cleanup);
  });

  it('threads session vendorOptions into buildCcRemoteHttpMcpServers (worker bootstrap race)', () => {
    // 验收实锤回归:factory 必须把 maker-core 透传的 vendorOptions 交给
    // buildCcRemoteHttpMcpServers — worker 首次创建时 DB 标记未写, 现场
    // 查库会 fail-closed 掉 send_to_lead。
    const destructureStart = source.indexOf('remoteCcQueryFactory: async ({');
    const destructureEnd = source.indexOf('}) => {', destructureStart);
    expect(destructureStart).toBeGreaterThan(-1);
    expect(destructureEnd).toBeGreaterThan(destructureStart);
    const destructure = source.slice(destructureStart, destructureEnd);
    const startParams = destructure.indexOf('startParams,');
    const vendorOptions = destructure.indexOf('vendorOptions,');
    const approvalRequest = destructure.indexOf('onApprovalRequest,');
    expect(startParams).toBeGreaterThan(-1);
    expect(vendorOptions).toBeGreaterThan(startParams);
    expect(approvalRequest).toBeGreaterThan(vendorOptions);
    const buildArgs = source.indexOf("workingDir: typeof startParams.cwd === 'string' ? startParams.cwd : '',");
    expect(buildArgs).toBeGreaterThan(-1);
    const passDown = source.indexOf('vendorOptions,', buildArgs);
    expect(passDown).toBeGreaterThan(buildArgs);
  });

  it('forces a fresh query on the first bridge-MCP injection per process (app restart reattach)', () => {
    // cc P1 回归:app 重启后 reattach 到 alive 旧 query, 旧 SDK 持有的
    // mcp-session-id 在新 bridge 不存在, attach 会让协同 MCP 永久 404。
    // factory 必须在首轮注入时传 forceFreshQuery, cc-manager-client 据此
    // kill alive + fresh start (resumeSdkSessionId 保上下文)。
    // greptile P1 回归:fresh 状态只在 open 成功后提交, 失败时下次重试
    // 仍要 forceFresh — add 必须在 forceFreshQuery 传参之后。
    const passDown = source.indexOf('forceFreshQuery,');
    expect(passDown).toBeGreaterThan(-1);
    const gate = source.indexOf('forcedFreshCcBridgeSessions.add(sessionId)');
    expect(gate).toBeGreaterThan(passDown);

    const killFirst = ccManagerClientSource.indexOf('killAliveForFresh');
    expect(killFirst).toBeGreaterThan(-1);
    const existingGuard = ccManagerClientSource.indexOf(
      'listedSession?.alive && !killAliveForFresh',
    );
    expect(existingGuard).toBeGreaterThan(killFirst);

    // greptile P1 回归:kill-for-fresh 失败不得吞错 — 旧 session 仍 alive
    // 时继续 fresh start 必撞 SESSION_ALREADY_EXISTS 且永久卡死;错误必须
    // 上抛, forcedFresh 状态不提交, 下次重试仍带 forceFreshQuery。
    const killForFreshBlock = ccManagerClientSource.slice(
      ccManagerClientSource.indexOf('if (killAliveForFresh) {'),
      ccManagerClientSource.indexOf('const existing =', killFirst),
    );
    expect(killForFreshBlock).not.toContain('.catch(() => undefined)');
    // greptile P1 回归②:registry.kill 对 alive session 是异步终止
    // (consume loop 退出后才移除) — kill 响应后必须轮询 list 确认不再
    // alive 才放行 start, 否则同撞 ALREADY_EXISTS。
    expect(killForFreshBlock).toContain('METHODS.SESSION_LIST');
    expect(killForFreshBlock).toContain('stillAlive');
  });

  it('clears forced-fresh tracking when the bridge instance is rebuilt', () => {
    // review P2 回归:custom MCP CRUD / 全局插件开关触发
    // shutdownCodexEnvironment 后 bridge lazy 重建, 旧 bridge 的
    // mcp-session-id 全部失效 — ensureCodexMcpBridgeStartedForRemote 必须
    // 检测实例更换并清空 forcedFresh 集合 (在返回新 bridge 之前), 否则
    // 已 fresh 的 session attach 回持旧 id 的 query, 协同 MCP 404。
    const ensureFn = source.indexOf('export async function ensureCodexMcpBridgeStartedForRemote');
    expect(ensureFn).toBeGreaterThan(-1);
    const clearIdx = source.indexOf('forcedFreshCcBridgeSessions.clear()', ensureFn);
    expect(clearIdx).toBeGreaterThan(ensureFn);
    // return 是多行对象字面量:匹配其中 port 行的位置。
    const returnIdx = source.indexOf('port: cfg.bridge.port', clearIdx);
    expect(returnIdx).toBeGreaterThan(clearIdx);
  });
});

describe('codex bridge shutdown strip detach gating (Greptile R30 P1)', () => {
  it('detaches idle remote codex sessions only after strip reboots the daemon', () => {
    const fnStart = source.indexOf('export function handleCodexEnvironmentShutdownForRemote');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('export async function ensureCodexMcpBridgeStartedForRemote', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = source.slice(fnStart, fnEnd);

    const stripCall = body.indexOf('stripRemoteCodexMcpConfig(host,');
    expect(stripCall).toBeGreaterThan(-1);
    const thenBlock = body.indexOf('.then((result) => {', stripCall);
    expect(thenBlock).toBeGreaterThan(stripCall);
    const gate = body.indexOf('if (!result.daemonRebootstrapped) return;', thenBlock);
    expect(gate).toBeGreaterThan(thenBlock);
    const detach = body.indexOf("detachActiveRemoteCodexSessions(hostId, 'bridge-shutdown-strip')", gate);
    expect(detach).toBeGreaterThan(gate);
    const detachCalls = body.match(/detachActiveRemoteCodexSessions\(hostId, 'bridge-shutdown-strip'\)/g) ?? [];
    expect(detachCalls).toHaveLength(1);
  });
});

describe('remoteCcQueryFactory stale-invalidation freshness (R22 P2)', () => {
  it('forces fresh for invalidated sessions even when nothing is injected this round', () => {
    // collab 禁用等场景:invalidate 过的 session 重建时无 server 可注
    // (injectedServerCount===0 且 needsFreshStart=false), 不 forceFresh 会
    // attach 回带旧 collab URL 的 query — stale 集合必须进入 forceFresh 判定。
    expect(source).toContain('staleInvalidatedCcSessions.has(sessionId)');
    // invalidate 的 clearFreshMark 必须同时记 stale。
    expect(source).toContain('staleInvalidatedCcSessions.add(sessionId)');
    // open 成功后提交 fresh 的同时必须清掉 stale 标记。
    const addFresh = source.indexOf('forcedFreshCcBridgeSessions.add(sessionId)');
    const delStale = source.indexOf('staleInvalidatedCcSessions.delete(sessionId)');
    expect(addFresh).toBeGreaterThan(-1);
    expect(delStale).toBeGreaterThan(addFresh);
  });
});

describe('cc-manager-client forced-fresh kill settle (Greptile R22/R23 P1)', () => {
  it('backs off the settle poll and never attaches to a kill-pending query (input would be silently dropped)', () => {
    const client = ccManagerClientSource;
    // 退避轮询 (150ms→1s), 覆盖 SSH 大 RTT / SDK abort 慢。
    expect(client).toContain('pollDelayMs');
    // 超时必须上抛:attach 到 inputQueue 已 end 的 query 会静默吞掉用户
    // 消息 (cc-mgr registry 注释实锤) — 降级 attach 路径不得存在。
    expect(client).toContain('still alive 30s after kill');
    expect(client).not.toContain('killSettled');
    expect(client).not.toContain('still-terminating');
    // 错误信息必须带可操作指引 (重试 / 重启远端 cc-mgr)。
    expect(client).toContain('restart the remote');
  });
});

describe('remoteCcQueryFactory persistent generation drift (R23 P2)', () => {
  it('drives forceFresh from the persisted cc generation fingerprint and writes it after open', () => {
    // collab 开→关 / token 轮换 / bridge 代际跨 app 重启:进程内集合清空
    // 也要靠 applied 指纹判出旧代际 query。
    expect(source).toContain('readCcAppliedFingerprint(sessionId)');
    expect(source).toContain('ccGenerationDrift');
    expect(source).toContain('mcpInjectFingerprint !== ccAppliedFingerprint');
    // drift 必须进入 forceFreshQuery 判定。
    expect(source).toContain('!forcedFreshCcBridgeSessions.has(sessionId)) ||');
    // open 成功后 (含 attach) 必须落盘 applied 指纹。
    expect(source).toContain('writeCcAppliedFingerprint(sessionId, appliedFingerprintToWrite)');
  });
});

describe('remoteCcQueryFactory drift override (R27 P1)', () => {
  it('does not let the forced-fresh set suppress a detected generation drift', () => {
    expect(source).toContain('ccGenerationDrift ||');
    const driftCheck = source.indexOf('ccGenerationDrift =');
    const forceFreshAssign = source.indexOf('const forceFreshQuery =', driftCheck);
    expect(forceFreshAssign).toBeGreaterThan(driftCheck);
    // drift 独立成项:豁免闭括号 (has(sessionId)) 之后的 || 分支即 drift。
    const exemptClose = source.indexOf('!forcedFreshCcBridgeSessions.has(sessionId)) ||', forceFreshAssign);
    const orDrift = source.indexOf('ccGenerationDrift ||', exemptClose);
    expect(exemptClose).toBeGreaterThan(forceFreshAssign);
    expect(orDrift).toBeGreaterThan(exemptClose);
  });
});

describe('remoteCcQueryFactory missing desired generation (Greptile R29 P1)', () => {
  it('forces a clean no-MCP query when injection cannot produce a desired fingerprint', () => {
    expect(source).toContain('CC_MCP_DISABLED_FINGERPRINT');
    expect(source).toContain('const ccMissingDesiredStale =');
    expect(source).toContain('mcpInjectFingerprint === undefined');
    expect(source).toContain('ccAppliedFingerprint !== CC_MCP_DISABLED_FINGERPRINT');
    expect(source).not.toContain(
      'mcpInjectFingerprint === undefined &&\n          ccAppliedFingerprint !== null &&',
    );

    const missingDesired = source.indexOf('const ccMissingDesiredStale =');
    const forceFreshAssign = source.indexOf('const forceFreshQuery =', missingDesired);
    const forceFreshBranch = source.indexOf('ccMissingDesiredStale;', forceFreshAssign);
    expect(forceFreshAssign).toBeGreaterThan(missingDesired);
    expect(forceFreshBranch).toBeGreaterThan(forceFreshAssign);

    const appliedWrite = source.indexOf('const appliedFingerprintToWrite =', forceFreshBranch);
    expect(appliedWrite).toBeGreaterThan(forceFreshBranch);
    expect(source.slice(appliedWrite, source.indexOf('if (appliedFingerprintToWrite)', appliedWrite))).toContain(
      'ccMissingDesiredStale ? CC_MCP_DISABLED_FINGERPRINT : undefined',
    );
    expect(source).toContain('writeCcAppliedFingerprint(sessionId, appliedFingerprintToWrite)');
  });
});
