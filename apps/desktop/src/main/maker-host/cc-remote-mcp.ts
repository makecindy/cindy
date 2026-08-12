/**
 * cc-remote-mcp — 远端 Claude Code query 的协同 MCP 注入。
 *
 * 与 codex 远端的路径差异:cc 的 MCP 配置是 per-query SDK 参数
 * (startParams.mcpServers, 经 cc-mgr 透传到 daemon 端 SDK),没有常驻
 * daemon 的 config.toml / env 问题。但身份通道与 codex 对齐:持久 bearer
 * token (safeStorage, 跨 app 重启稳定) 鉴权 + URL query
 * `?session=<id>&instance=<opaque>`
 * 路由 session ctx。持久 token 解决 detach/reattach 与 app 重启后旧 query
 * 重建时的 token 失效问题;ctx 注册表是内存态,query 重建时重新注册,
 * query close 时注销。
 *
 * 复用:bridge (codexEnvironment 单例) 与 remote-forward (per-host 固定
 * 端口, 与 codex daemon 共用同一条) 与 codex 路径完全一致。
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

import type { CodexHttpBridge } from '../mcp-integrations/codexHttpBridge.js';
import {
  computeRemoteMcpFingerprint,
  selectRemoteInjectableServerNames,
  withMcpRouteIdentity,
} from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';
import { getSessionOrcaRole, getWorkerLink } from '../localDb/orcaTeamStore.js';

/**
 * cc remote 的 MCP session ctx 合成:与 synthesizeOrcaVendorOptionsFromDb
 * (maker-ipc/orcaSessionStartOptions.ts) 同一语义,但这里不能反向依赖
 * maker-ipc,按 orcaTeamStore 直接合成 lead/worker 两分支。
 */
export async function synthesizeCcRemoteVendorOptions(
  sessionId: string,
): Promise<Record<string, unknown>> {
  try {
    const role = await getSessionOrcaRole(sessionId);
    if (role === 'lead') {
      return { orcaRole: 'lead', orcaLeadSessionId: sessionId };
    }
    if (role === 'worker') {
      const link = await getWorkerLink({ workerSessionId: sessionId });
      if (link) {
        return {
          orcaRole: 'worker',
          orcaWorkflowId: link.teamId,
          orcaLeadSessionId: link.leadSessionId,
          orcaWorkerId: link.workerId,
          orcaWorkerSessionId: sessionId,
        };
      }
    }
  } catch {
    // 非 orca session 或 DB 未就绪:空 vendorOptions,控制类工具按无角色拒绝。
  }
  return {};
}

export interface CcRemoteHttpMcpDeps {
  ensureBridgeStarted: () => Promise<{
    port: number;
    serverNames: string[];
    bridge: CodexHttpBridge;
  } | null>;
  ensureForward: (host: RemoteHost, localBridgePort: number) => Promise<number>;
  synthesizeVendorOptions?: (sessionId: string) => Promise<Record<string, unknown>>;
  /**
   * Collab 全局开关 (plugin registry Tier 4)。缺省视为开启。provider 层在
   * 禁用时仍注册 cindy_orca (keepOrcaProviderStable 保工具面稳定), bridge
   * 名单不反映开关 — 远端注入必须以本闸门为准, 禁用时整个不注入
   * (codex-connector R20 P2, 与 codex daemon 侧同一语义)。
   */
  isCollabEnabled?: () => boolean;
  /**
   * 持久 bridge token;测试注入 stub,生产默认 safeStorage 真源。
   * 可同步可异步;返回 null = token 不可用,注入降级为空 (不得下发
   * "Bearer null")。
   */
  getBridgeToken?: () => Promise<string | null> | string | null;
}

export interface CcRemoteHttpMcpServerConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

/**
 * 为远端 cc query 构建 http 形态的 MCP server 配置。返回的 cleanup 必须在
 * query close 时调用,注销 session ctx (detach 不清,重建时重新注册覆盖)。
 * cleanup 带代际比较:同 session 重建覆盖了新 ctx 时,旧 query 迟到的
 * cleanup 不得误删新 ctx。
 *
 * vendorOptions 优先级:args.vendorOptions (session 创建方显式声明, 与本地
 * in-process MCP 同源) 为准;缺失时才回退 DB 合成。worker 首次创建时 DB 的
 * orca 标记发生在 bootstrap 之后, 现场查库会拿到空角色导致 worker 工具被
 * fail-closed ("not an orca worker session") — 真实验收实锤。
 */
export async function buildCcRemoteHttpMcpServers(
  args: {
    host: RemoteHost;
    sessionId: string;
    /** 当前 Maker Session 实例代号；作为 opaque bridge route identity 下发。 */
    sessionInstanceId?: string;
    workingDir: string;
    /** session 自己的 vendorOptions (maker-core startSession 透传); 优先于 DB 合成。 */
    vendorOptions?: Record<string, unknown>;
    /**
     * per-session Maker Memory 开关 (maker-core startSession 归一后透传)。
     * true 时把 cindy_memory 一并注入 — 必须与 maker-core 的 prompt 注入
     * (rules + MEMORY.md index) 同源同值, 否则模型被 rules 引导去调不存在
     * 的工具。缺省 false。
     */
    makerMemoryEnabled?: boolean;
  },
  deps: CcRemoteHttpMcpDeps,
): Promise<{
  servers: Record<string, CcRemoteHttpMcpServerConfig>;
  cleanup: () => void;
  /**
   * true = 调用方应对已有 alive query 走 forceFresh (kill + fresh start):
   * 本要注入但 token 不可用时, attach 回带旧 Authorization header 的旧
   * query 会让协同 MCP 持续 401 — 重建为「无协同」的干净 query 才是
   * fail-closed (codex-connector R21 P2)。
   */
  needsFreshStart?: boolean;
  /**
   * 本次注入 (或禁用) 的代际指纹 — 调用方在 open 成功后经
   * writeCcAppliedFingerprint 落盘;下次 open 前与 readCcAppliedFingerprint
   * 比对, 不一致说明存活 query 的 MCP 配置属旧代际, 应 forceFresh
   * (codex-connector R23 P2)。bridge 不在 / token 缺失时为 undefined
   * (不驱动 drift)。
   */
  fingerprint?: string;
}> {
  const empty: { servers: Record<string, CcRemoteHttpMcpServerConfig>; cleanup: () => void; needsFreshStart?: boolean } = {
    servers: {},
    cleanup: () => {},
  };
  const started = await deps.ensureBridgeStarted();
  if (!started) return empty;
  // collab 全局禁用时 bridge 名单不反映开关 (keepOrcaProviderStable) —
  // 远端注入以同一闸门为准, 协同段整个不注入 (codex-connector R20 P2)。
  // cindy_memory 独立走 per-session Maker Memory 开关, 与 collab 互不牵连。
  // 合成规则唯一真源在 selectRemoteInjectableServerNames (codexHttpBridge.ts)。
  const names = selectRemoteInjectableServerNames(started.serverNames, {
    collabEnabled: deps.isCollabEnabled?.() ?? true,
    memoryEnabled: args.makerMemoryEnabled === true,
  });
  if (names.length === 0) {
    // 无注入也是一代 (collab 禁用 / 白名单空):指纹常量 'disabled',
    // 开→关的重启后 drift 判定成立 (R23 P2);不含 instanceId, 一直禁用
    // 的健康 query 不被误判。
    // 禁用必须同时摘掉本 session 在 bridge 上的旧 ctx (此前注入注册):
    // 不摘的话 ?session=<id> 的授权路由在 collab 已禁用后仍可用, 直到
    // bridge 关闭 (codex-connector R26 P2)。token 轮换/失效不需要这里
    // 清 — 鉴权层已按新 token 拒旧请求。
    started.bridge.unregisterSessionCtx(args.sessionId);
    return { ...empty, fingerprint: CC_MCP_DISABLED_FINGERPRINT };
  }
  const remotePort = await deps.ensureForward(args.host, started.port);
  // token 可用性必须在 register 之前确认:null 时下发出 "Bearer null" 还
  // 保留已注册 ctx (注册后失败无任何 cleanup 可达, 见 race review P1)。
  const bridgeToken = await (deps.getBridgeToken ?? getRemoteMcpBridgeToken)();
  if (!bridgeToken) {
    // token 失效但本要注入 (names 非空):标记 needsFreshStart — 否则调用方
    // 按 injectedServerCount===0 不 forceFresh, attach 回带旧 token header
    // 的 alive query, 协同 MCP 持续 401 (codex-connector R21 P2)。
    return { ...empty, needsFreshStart: names.length > 0 };
  }
  const synthesize = deps.synthesizeVendorOptions ?? synthesizeCcRemoteVendorOptions;
  const ctx = {
    agentKind: 'claude-code' as const,
    sessionId: args.sessionId,
    mcpCallerKind: 'root' as const,
    mcpCallerAttested: true,
    ...(args.sessionInstanceId ? { sessionInstanceId: args.sessionInstanceId } : {}),
    workingDir: args.workingDir,
    // remote ctx: scope key 语义见 maker-core buildMemoryScopeKey。
    remoteHostId: args.host.id,
    vendorOptions: args.vendorOptions ?? (await synthesize(args.sessionId)),
  };
  // 同 session 重建 (resume/rebuild/reattach) 直接覆盖注册,注册表以 sessionId
  // 为 key,天然不累积。
  started.bridge.registerSessionCtx(args.sessionId, ctx);
  try {
    const servers = Object.fromEntries(
      names.map((name) => [
        name,
        {
          type: 'http' as const,
          url: withMcpRouteIdentity(`http://127.0.0.1:${remotePort}/mcp/${name}`, {
            sessionId: args.sessionId,
            sessionInstanceId: args.sessionInstanceId,
          }),
          headers: { Authorization: `Bearer ${bridgeToken}` },
        },
      ]),
    );
    return {
      servers,
      cleanup: () => started.bridge.unregisterSessionCtx(args.sessionId, ctx),
      fingerprint: computeRemoteMcpFingerprint({
        token: bridgeToken,
        bridgeInstanceId: started.bridge.instanceId,
        remotePort,
        serverNames: names,
        sessionInstanceId: args.sessionInstanceId,
      }),
    };
  } catch (err) {
    // 注册后失败必须回滚,否则调用方拿不到 cleanup,ctx 永久残留。
    started.bridge.unregisterSessionCtx(args.sessionId, ctx);
    throw err;
  }
}

// ── per-session 注入代际指纹持久化 (R23 P2:跨 app 重启的 stale 判定) ─────────

/**
 * 远端 CC query 的注入代际指纹。与 codex daemon 的 appliedFingerprint 同
 * 思想 (daemon env/config 一致性必须是持久事实, 不能靠进程内存集合):
 * cc 的注入虽是 per-query startParams, 但「这条 query 是用哪一代 MCP 配置
 * 建的」同样是跨重启必须可判的事实 — collab 开→关 + app 重启后, 进程内
 * stale 集合清空, 没有它 factory 会 attach 回带旧 collab URL 的 query
 * (codex-connector R23 P2)。
 *
 * 成分:token|bridgeInstanceId|remotePort|serverNames (注入代际; server 名单
 * 进指纹 — cc 的注入集合随 per-session Maker Memory 开关变化, 开关翻转后
 * attach 回旧集合的 alive query 必须判为 drift 重建), 公式唯一真源在
 * computeRemoteMcpFingerprint (codexHttpBridge.ts, 与 codex 侧共用);无注入
 * 代际用常量 'disabled' (collab 与 memory 都关 / 白名单为空) — 不含
 * instanceId, 避免「一直禁用」的健康 query 在每次 bridge 重建后被误判
 * drift 白杀。bridge 不在 (shutdown) 时不产指纹 — 判定方跳过 (forceFresh
 * 也无 bridge 可用, 恢复由 lazy 重建路径负责)。
 */

const CC_DISABLED_GENERATION = 'disabled';

export const CC_MCP_DISABLED_FINGERPRINT = CC_DISABLED_GENERATION;

type CcFreshPrefs = Record<string, string>;

function ccFreshPrefsPath(): string {
  return path.join(app.getPath('userData'), 'remote-cc-mcp-fresh.json');
}

let ccFreshPrefsCache: CcFreshPrefs | null = null;

function readCcFreshPrefs(): CcFreshPrefs {
  if (ccFreshPrefsCache) return ccFreshPrefsCache;
  const file = ccFreshPrefsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      const out: CcFreshPrefs = {};
      if (raw && typeof raw === 'object') {
        for (const [sessionId, fp] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof fp === 'string' && fp.length > 0) out[sessionId] = fp;
        }
      }
      ccFreshPrefsCache = out;
      return out;
    }
  } catch {
    // 读失败按空处理 (下次写入覆盖)。
  }
  ccFreshPrefsCache = {};
  return ccFreshPrefsCache;
}

export function readCcAppliedFingerprint(sessionId: string): string | null {
  return readCcFreshPrefs()[sessionId] ?? null;
}

export function writeCcAppliedFingerprint(sessionId: string, fingerprint: string): void {
  const next = { ...readCcFreshPrefs(), [sessionId]: fingerprint };
  const file = ccFreshPrefsPath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  ccFreshPrefsCache = next;
}
