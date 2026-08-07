/**
 * Desktop AgentRuntimeConfig 实现。
 * endpoint、行为开关与宿主资源路径由 desktop host 在这里统一注入,
 * maker-core 只消费抽象配置,不依赖 Electron 或部署环境。
 */

import type { AgentRuntimeConfig } from '@cindy/maker-core';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';

import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { getActiveCatalog } from './active-catalog.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import { claudeBehaviorFlagsForSpawn } from './claude-behavior-flags.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import claudeSystemPrompt from './claude-system-prompt.md?raw';
import codexSystemPrompt from './codex-system-prompt.md?raw';
import hostSystemPrompt from './host-system-prompt.md?raw';
import skillSourcePrecedencePrompt from './skill-source-precedence-prompt.md?raw';
import { readCompactionPct } from './compaction-settings-store.js';
import { readMemorySettings } from './memory-settings-store.js';
import { readSubagentModelSettings } from './subagent-model-settings-store.js';
import { toolchainThreadCapEnv } from './toolchain-thread-cap.js';

// Claude / Codex 的 host system prompt：产品身份 → Skill 来源优先级 → agent 专属段。
// Skill 优先级不放 host-system-prompt.md，避免把 #1645 的 Claude/Codex 行为扩到 Pi。
function composeHostPrompt(agentSpecific: string): string {
  return [hostSystemPrompt, skillSourcePrecedencePrompt, agentSpecific]
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .join('\n\n');
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function ripgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

// 探测结果 memoize:pathPrepends getter 每次 codex spawn 都会读、getRipgrepBinaryPath
// 被 file-browser / pi-host 每次搜索调用,不能每次都重打 fs 探测 + chmod。
// 只缓存成功结果 —— 探测失败的 throw 不缓存,下次调用重新探测(dev 期补装 rg 后
// 不必纠结缓存住了失败态)。
let cachedBundledRipgrepDir: string | undefined;

// 不在模块顶层调用(issue #1956):本函数在 dev/测试分支依赖 app.getAppPath(),
// 顶层求值会让任何 import 链摸到本模块的纯 node / vitest 环境在收集阶段就炸。
// 调用点:desktopCodexRuntimeConfig.pathPrepends 的 lazy getter、
// getRipgrepBinaryPath(),以及启动期 fail-fast 的 ensureBundledRipgrepReady()。
function bundledRipgrepDir(): string {
  if (cachedBundledRipgrepDir) return cachedBundledRipgrepDir;
  const key = platformKey();
  const file = ripgrepBinaryName();
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'tools', 'ripgrep')]
    : [
        // 非打包环境(dev / 测试)首选 app 目录;测试环境的 electron mock 可能
        // 不提供 getAppPath,此时跳过该候选,用 cwd 相对候选兜底。
        ...(typeof app.getAppPath === 'function'
          ? [path.join(app.getAppPath(), '..', '..', 'apps', 'ripgrep-bin', key)]
          : []),
        path.join(process.cwd(), 'apps', 'ripgrep-bin', key),
        path.join(process.cwd(), '..', 'ripgrep-bin', key),
      ];

  for (const dir of candidates) {
    const bin = path.join(dir, file);
    if (!fs.existsSync(bin)) continue;
    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
    }
    cachedBundledRipgrepDir = dir;
    return dir;
  }

  throw new Error(
    `Bundled ripgrep not found for ${key}. Run "pnpm install:ripgrep" before starting desktop dev or packaging.`,
  );
}

/**
 * Public accessor for the bundled ripgrep executable's full path. Used by
 * file-browser/search 等需要 spawn rg 子进程的模块。Throws if rg 未找到 ——
 * 与 bundledRipgrepDir() 同样的找不到时炸开行为(不容许静默退化)。
 */
export function getRipgrepBinaryPath(): string {
  return path.join(bundledRipgrepDir(), ripgrepBinaryName());
}

/**
 * 启动期 fail-fast 预热(issue #1956):import 本模块不再探测 ripgrep(见
 * desktopCodexRuntimeConfig.pathPrepends 的 lazy getter),缺 rg 的显式失败由
 * 两个启动期调用点承担 —— bootstrap 的 splash check-environment(Phase 2.5,
 * 缺失时 splash 进失败态可重试,与 claude/codex binary 缺失同一体验)和
 * getMaker() 首次构造(防御性断言,与那里的 claude/codex 检查同层)。
 * dev 忘跑 "pnpm install:ripgrep" 会在 splash 即失败;生产打包缺资源同样
 * 在启动期暴露,语义不变。
 */
export function ensureBundledRipgrepReady(): void {
  bundledRipgrepDir();
}

// memorySettings 在 main 启动期已 ready (userData 同步可访问)。
// 原生 auto-memory 与 Maker Memory 都从持久化 store 读, 重启后用户上次设置 100% 恢复。
// 默认值由 memory-settings-store.ts 维护 (maker=false / claudeCode=true / codex=true)。
function readMakerMemoryEnabled(): boolean {
  return readMemorySettings().maker;
}

// behaviorFlags 拆到 claude-behavior-flags.ts(零依赖,可单测)。attribution 归因块
// 按 spawn 形态决定 —— oauth-spawn 禁用 '0' 会让订阅直连的 Auto 分类器子请求被上游
// 429,auto 模式所有写操作 fail-closed(issue #758),详见该模块头注释。

/**
 * Claude Code 真正的上游 endpoint —— 既给本地 anthropic-compat-proxy 做 upstream,
 * 也给 claudeAccountUsage 等需要直连的旁路调用使用。
 *
 * 注意:Claude Code 子进程看到的 ANTHROPIC_BASE_URL 不是这个值,而是本地代理的
 * loopback URL(由 anthropic-compat-proxy-host 在 splash 阶段启动后注入到
 * desktopClaudeRuntimeConfig.endpoint)。代理在转发到这里前会按 model 名判断,
 * 把 Anthropic-only 字段(output_config / thinking / cache_control / betas)从
 * 非 Claude 模型(gpt-5.4 / kimi 等)的请求里 strip 掉,绕开上游 Azure backend
 * "Unknown parameter" 400 错误。
 */
// 惰性函数而非模块级常量:model-access 凭据同步在登录后才写入 endpoint,顶层求值会钉死空值。
// 只认 server 随凭据成对下发的租户 endpoint,同步成功前返回空串(网关不可用)——
// 保证 key 与 endpoint 永远同租户(见 model-access/effectiveEndpoint.ts)。
export function claudeUpstreamEndpoint(): string {
  return effectiveXdGatewayBaseUrl();
}

/**
 * Claude 运行时配置工厂 ——
 *
 * 对应迁移自 vendor/claude/authAdapter.ts:66-78 的 ANTHROPIC_BASE_URL +
 * CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS, 并额外注入 maker 侧自动压缩阈值。
 *
 * @param endpointFn 返回 Claude Code 子进程当前应该用的 ANTHROPIC_BASE_URL 的函数。
 *   **必须传函数而不是字符串**: 每次 spawn(startSession) 时 env-builder 会读
 *   `runtimeConfig.endpoint`, 我们用 getter 让它每次都调用这个函数读最新值。
 *   proxy 在 splash 期异步启动, getter 保证每次新建 session 都拿到当时最新的就绪状态,
 *   不需要重启 app 或重置 Maker 单例。
 *
 *   传 `getClaudeEndpoint`(函数引用)即可。getClaudeEndpoint 内部已经处理:
 *     proxy ready → loopback URL(请求经 proxy 做 per-model 路由 + 字段适配);
 *     proxy 没起  → 真上游 + warn(fail-open 兜底)。
 */
export function buildDesktopClaudeRuntimeConfig(endpointFn: () => string): AgentRuntimeConfig {
  // 用 plain object + Object.defineProperty 装 getter, 而不是 class 实例。
  // 这样 AgentRuntimeConfig 接口(endpoint?: string)在结构类型上仍然成立 ——
  // 每次访问 runtimeConfig.endpoint 都会执行 endpointFn, 拿到当时最新的兼容模式状态。
  const config: AgentRuntimeConfig = {
    // behaviorFlags 用函数形态:env-builder 在每次 spawn 时以该 spawn 的 credentialMode
    // 调用 —— gateway-key spawn(显式 XD source / SSH remote)保持禁归因且不读钥匙串,
    // 其余形态按**当时**的 Claude.ai 订阅连接态决定(判据与 proxy 同源)。会话中途
    // 连/断订阅只影响新 spawn —— 与 cc 子进程凭证冻结语义一致。
    behaviorFlags: (ctx) => ({
      ...claudeBehaviorFlagsForSpawn({
        credentialMode: ctx.credentialMode,
        oauthConnected: hasClaudeAiOAuth,
      }),
      // 工具链限核 env(agent 资源占用治理):只对本机 spawn 注入 —— 值按本机
      // 核数算,远端机器的资源不归本设置管。设置关闭时为空对象,零影响。
      ...(ctx.spawnMode === 'remote' ? {} : toolchainThreadCapEnv()),
    }),
    // 产品身份 + Skill 来源优先级 + Claude 专属段，按顺序拼接后给 maker-core append。
    systemPrompt: composeHostPrompt(claudeSystemPrompt),
    // Maker Memory 需要的 user-data 绝对路径 (maker-core 没 Electron 依赖, 必须 host 注入)。
    userDataPath: app.getPath('userData'),
    get memoryEnabled() {
      return readMemorySettings().claudeCode;
    },
    // main-side session starts can omit per-session makerMemoryEnabled. Keep the fallback live
    // so settings changed after app startup apply without requiring a restart.
    get makerMemoryEnabled() {
      return readMakerMemoryEnabled();
    },
  };
  // 远端 cc-mgr 会话恒用真上游网关 —— 本地 endpoint 是 loopback proxy(远端够不到)。
  // 用 getter 而非构建期快照:model-access 凭据同步可能在 maker 构建后才把
  // endpoint 换成下发值,远端 spawn 期读 getter 才能拿到与 key 配套的上游。
  Object.defineProperty(config, 'remoteEndpoint', {
    get: () => claudeUpstreamEndpoint(),
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(config, 'endpoint', {
    get: endpointFn,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(config, 'autoCompactThresholdPct', {
    get: () => readCompactionPct(),
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(config, 'subagentModel', {
    // 无路由上下文的兜底口径(subagentModelForRoute 缺席的消费方用):目录里该模型
    // 的所有拷贝都被停用才丢弃覆写。
    get: () => resolveSubagentModelForRoute(undefined),
    enumerable: true,
    configurable: false,
  });
  // 停用轴(PR #744 review 第十六、十九轮):保存的 subagent 覆写
  // (CLAUDE_CODE_SUBAGENT_MODEL)是每次 Agent 工具调用的新付费请求路由,而子代理
  // 跑在**父会话来源**上 —— 判定必须按该来源的那份拷贝:父会话钉 XD、XD 拷贝被停用
  // 时,Anthropic 家有启用拷贝也不能豁免。env-builder 每次 spawn 传入会话来源。
  // 同步热路径,只用同步源(active catalog + override store)。
  config.subagentModelForRoute = (providerId, credentialMode) =>
    resolveSubagentModelForRoute(providerId, credentialMode);
  return config;
}

/**
 * providerId:string = 显式来源;null = 隐式默认 —— 按 spawn 已解析的凭证形态映射
 * 实际落点(gateway-key = xd / oauth-bearer = Anthropic 直连;静态猜 xd 会在 XD 未
 * 连接、走 Anthropic 订阅时判错,PR #744 review 第二十轮);undefined = 完全无路由
 * 上下文(退回「全部拷贝停用才丢弃」的保守判)。
 */
function resolveSubagentModelForRoute(
  providerId: string | null | undefined,
  credentialMode?: string,
): string | undefined {
  const saved = readSubagentModelSettings().claudeCode ?? undefined;
  if (!saved) return undefined;
  const overrides = readModelDisableOverrides();
  const offering = getActiveCatalog().providers.filter((p) =>
    (p.models['claude-code'] ?? []).some((m) => m.id === saved),
  );
  if (offering.length === 0) return saved; // 目录不认识 → 不新增拒绝面
  const copyDisabled = (id: string) =>
    isProviderDisabled(overrides, id) || isModelDisabled(overrides, id, saved);
  if (providerId !== undefined) {
    const implicitRouteId =
      credentialMode === 'gateway-key'
        ? 'xd'
        : credentialMode === 'oauth-bearer'
          ? 'anthropic'
          : null;
    const routeProvider = providerId
      ? offering.find((p) => p.id === providerId)
      : implicitRouteId
        ? offering.find((p) => p.id === implicitRouteId)
        : undefined;
    // 显式/映射来源不提供该模型(跨来源 subagent 覆写)或凭证形态未知:实际落点
    // 不明,落到下方保守判。
    if (routeProvider) return copyDisabled(routeProvider.id) ? undefined : saved;
  }
  const allDisabled = offering.every((p) => copyDisabled(p.id));
  return allDisabled ? undefined : saved;
}

/**
 * Codex 运行时配置：当前没有 proxy URL 覆盖。
 * systemPrompt 已接通 —— codex agent 在 thread/start 时跟 engine append 拼成
 * developerInstructions 注入 codex 子进程 (见 codex/index.ts)。
 */
export const desktopCodexRuntimeConfig: AgentRuntimeConfig = {
  // 工具链限核 env(agent 资源占用治理)。注意:远端 codex spawn 也会执行
  // buildCodexEnv(其产物随后被远端 transport 整体丢弃,见 codex/index.ts:1917
  // 附近注释),所以这里仍按 spawnMode 分流让代码自证,不依赖"远端不走本函数"
  // 这种会过期的假设(对抗式预审发现)。
  behaviorFlags: (ctx) => (ctx.spawnMode === 'remote' ? {} : toolchainThreadCapEnv()),
  // 产品身份 + Skill 来源优先级 + Codex 专属段。
  systemPrompt: composeHostPrompt(codexSystemPrompt),
  // lazy getter(与 endpoint/memoryEnabled 同一惯用法,issue #1956):import 期
  // 不探测 bundled ripgrep,纯 node / vitest 环境 import 本模块不再炸;真正的
  // fail-fast 由 maker-host 启动期的 ensureBundledRipgrepReady() 承担,此处 getter
  // 在 env-builder 每次 codex spawn 时求值(结果已 memoize)。
  get pathPrepends() {
    return [bundledRipgrepDir()];
  },
  userDataPath: app.getPath('userData'),
  get memoryEnabled() {
    return readMemorySettings().codex;
  },
  // Keep this fallback live for main-side session starts that do not pass CreateOpts.makerMemoryEnabled.
  get makerMemoryEnabled() {
    return readMakerMemoryEnabled();
  },
};
