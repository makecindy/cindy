/**
 * Host 与桌面之间的源码契约（guard 层）。
 *
 * 这些断言读生产源码的文本，不经生产入口：它们保护的是“Host 照抄或照接桌面的某几行”这类跨文件
 * 静态契约，原先分散在 Host 与桌面的普通单测里，按测试规范集中到这里。行为断言留在原文件。
 * 读源码后统一把 \r\n 换成 \n，Windows 检出的 CRLF 不影响结果。
 *
 * 每一条的规则与失效后果写在用例上方。共同的后果：一边改了而另一边没跟上时，Host 上的任务与桌面
 * 上同一任务的行为悄悄分叉，对照测试与放行表的“已对齐”结论随之失效。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../../../../..');
const hostSrc = path.join(repo, 'apps/host/src');
const hostAgent = path.join(hostSrc, 'agent');
const desktopMain = path.join(repo, 'apps/desktop/src/main');
const desktopIndex = path.join(desktopMain, 'maker-host/index.ts');
const piHostFile = path.join(desktopMain, 'maker-host/pi-host.ts');
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');

/** The source text from `from` up to `to`, one trimmed line each, comments and blank lines dropped. */
function between(source: string, from: string, to: string, keepBlank = false): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, from);
  const end = source.indexOf(to, start);
  assert.ok(end > start, to);
  return source.slice(start, end).split('\n').map(line => line.trim())
    .filter(line => (keepBlank || line) && !line.startsWith('//')).join('\n');
}

/** A balanced call expression starting at `start`, without comments, whitespace or trailing commas. */
function call(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `${start} not found`);
  let depth = 0;
  let end = at;
  for (let i = at + start.length - 1; i < source.length; i++) {
    if ('({['.includes(source[i])) depth += 1;
    if (')}]'.includes(source[i])) depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
  return source.slice(at, end).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
}

describe('Host main.ts wiring', () => {
  // 放行表第 33 项：两端必须共享同一个裁决、超时和熔断工厂。行为测试能证明单个输入的
  // 结果相同，不能隔离“另一端改用独立工厂”的结构变化。
  it('builds the desktop and Host plugin controls from the same factory', () => {
    const desktop = read(path.join(desktopMain, 'cindy-brain/runtimePluginHost.desktop.ts'));
    const host = read(path.join(hostSrc, 'plugins/runtime.ts'));
    assert.match(desktop, /import \{ createRuntimePluginHost, [^\n]+ from '\.\/runtimePluginHostCore\.js'/);
    assert.match(host, /import \{ createRuntimePluginHost, [^\n]+ from '\.\.\/\.\.\/\.\.\/desktop\/src\/main\/cindy-brain\/runtimePluginHostCore\.js'/);
    assert.match(desktop, /return createRuntimePluginHost\(/);
    assert.match(host, /const taskPlugins = createRuntimePluginHost\(/);
  });

  // MCP 注册协议：platformTools 已并入 hostTools，最终交给引擎时不能再次展开。
  // Bug：main 合并冲突会重复注册同名服务；main 顶层会启动 Host，故在 guard 层保护组装边界。
  it('registers platform providers once through the shared Host tools list', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.equal(main.split('hostTools.providers.push(...platformTools.providers);').length - 1, 1);
    const registration = call(main, 'pluginGateway.prepareMcpProviders(');
    assert.equal(registration.split('...hostTools.providers').length - 1, 1);
    assert.equal(registration.includes('platformTools.providers'), false);
  });

  // 规则：放行表第五节“甲：账号边界停止提前置位”。退出登录、会话失效、有序关闭都经 runOwnerBoundary
  // （agent/owner-boundary.ts），它的 begin 是这条路的第一步，早于任何拆除；退出登录的登出与吊销在 dispose 之后；
  // HTTP 退出登录入口先 begin、再关平台客户端。失效后果：拆依赖时失败的回合写下结束时间与错误行，显示成错误。
  // main 顶层会启动 Host，单测只能驱动 runOwnerBoundary 本身，故接线在 guard 层钉住。
  it('begins every owner boundary through runOwnerBoundary, before its teardown', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.equal(main.split('runOwnerBoundary(ownerBoundary, {').length - 1, 3);
    assert.equal(main.split('ownerBoundary.begin()').length - 1, 1, 'the only direct begin is the HTTP logout dep');
    const logout = main.slice(main.indexOf('  logout: async () => {'), main.indexOf('  listSessions: async'));
    const logoutBoundary = logout.indexOf('runOwnerBoundary(ownerBoundary, {');
    assert.ok(logoutBoundary > 0);
    for (const teardown of ['disposeOwnerRuntime', 'logoutHostSession(', 'withCrossProcessLock(']) {
      assert.ok(logout.indexOf(teardown) > logoutBoundary, `${teardown} runs inside the logout boundary`);
    }
    assert.ok(logout.indexOf('dispose: disposeOwnerRuntime') < logout.indexOf('afterDispose:'), 'sign out after dispose');
    assert.ok(logout.indexOf('logoutHostSession(') > logout.indexOf('afterDispose:'));
    const invalidate = main.slice(main.indexOf('function invalidateHostSession('), main.indexOf('const serverApi = '));
    const invalidateBoundary = invalidate.indexOf('runOwnerBoundary(ownerBoundary, {');
    assert.ok(invalidateBoundary > 0);
    for (const teardown of ['beginAppSessionBoundary()', 'pauseOwnerRequests()', 'interactionBroker.dispose()', 'disposeOwnerRuntime']) {
      assert.ok(invalidate.indexOf(teardown) > invalidateBoundary, `${teardown} runs inside the invalidation boundary`);
    }
    const stop = main.slice(main.indexOf('const stop = () => {'), main.indexOf("process.once('SIGINT', stop);"));
    const stopBoundary = stop.indexOf('runOwnerBoundary(ownerBoundary, {');
    assert.ok(stopBoundary > 0);
    for (const teardown of ['server.stopAccepting()', 'beginAppSessionBoundary()', 'reapCodexToolTreesSync();', 'await disposeOwnerRuntime();']) {
      assert.ok(stop.indexOf(teardown) > stopBoundary, `${teardown} runs inside the shutdown boundary`);
    }
    const server = read(path.join(hostSrc, 'server.mjs'));
    const httpLogout = server.slice(server.indexOf('  const logout = () => {'), server.indexOf('  const server = createServer('));
    assert.ok(httpLogout.indexOf('deps.beginOwnerBoundaryStop?.()') > 0);
    assert.ok(httpLogout.indexOf('deps.beginOwnerBoundaryStop?.()') < httpLogout.indexOf('deps.platformClient?.()?.close()'));
  });

  // 规则：Host 的 main.ts 先加载 boot-env（清掉终端继承来的 Anthropic 变量），紧接着 boot-settings
  // （读不懂的设置文件保留）。失效后果：别的模块先读到继承来的凭据，或在默认值设好之前删掉用户的设置文件。
  it('loads boot-env first and boot-settings right after it', () => {
    const imports = read(path.join(hostSrc, 'main.ts')).split('\n').filter(line => line.startsWith('import '));
    assert.deepEqual(imports.slice(0, 2), ["import './boot-env.js';", "import './boot-settings.js';"]);
  });

  // 规则：Host 建的每个 Cindy 账号客户端都经 hostAuthFetch（出口代理）。失效后果：账号请求绕过出口代理。
  it('builds every Cindy auth client on hostAuthFetch', () => {
    for (const [file, count] of [['main.ts', 2], ['login-cli.mjs', 1]] as const) {
      const source = read(path.join(hostSrc, file));
      assert.equal(source.split('new CindyAuthClient(').length - 1, count, file);
      assert.equal(source.split('fetch: (input, init) => hostAuthFetch(input, init),').length - 1, count, file);
      assert.equal(source.includes('globalThis.fetch'), false, file);
    }
    const helper = read(path.join(hostSrc, 'auth-fetch.mjs'));
    assert.ok(helper.includes('export const hostAuthFetch = (input, init) => hostOutbound.outboundFetch(input, init);'));
  });

  // 规则：Host 进程启动时在 macOS 上读静态系统代理设置（放行表第 28 行 28b）：main.ts 在分发命令之前调一次
  // startHostSystemProxySettings（登录命令也走出口代理），它只在 darwin 上接 scutil 读取，scutil 写死绝对路径。
  // 单测注入固定的 scutil 输出，走不到这一行。失效后果：Host 不再跟随系统代理，只靠系统代理才能连出去的
  // 用户全部直连；或 scutil 经 PATH 查找、被同名程序顶替。
  it('reads the macOS system proxy settings at startup, with the system scutil', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.ok(main.includes("import { describeHostOutboundProxy, describeOutboundProxyLine, startHostSystemProxySettings, stopHostSystemProxySettings } from './outbound-proxy.ts';\n"));
    assert.equal(main.split('startHostSystemProxySettings()').length - 1, 1);
    assert.ok(main.includes("command === undefined || command === 'serve' || command === 'login'\n  ? startHostSystemProxySettings().catch("));
    assert.ok(main.includes('await proxyWarmup;\n    await runLoginCommand(process.argv.slice(3));'));
    const rules = read(path.join(hostSrc, 'macos-system-proxy.ts'));
    assert.ok(rules.includes("const SCUTIL_PATH = '/usr/sbin/scutil';\n"));
    assert.equal(rules.split('execFile(').length - 1, 1);
    assert.ok(rules.includes("    execFile(SCUTIL_PATH, ['--proxy'], {\n"));
  });

  // 规则：Host 进程只装一次桌面在启动时填的三个运行时选择槽（owner 提交边界的清理、任务读取的投影器、归档与
  // 删除时的清理，runtime-selection.ts bindHostSessionRuntimeHooks），在模块顶层、建好运行时选择之后（早于
  // 任何 owner 提交）；删除任务时与归档一样在路线锁里调清理。行为测试经 bindHostSessionRuntimeHooks 本身，
  // 走不到 main.ts 这几行。失效后果：换账号后残留运行时调整、读到的模型与实际路线不一致、删除的任务留着调整。
  it('binds the runtime selection slots once at top level and cleans a deleted task', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.equal(main.split('bindHostSessionRuntimeHooks(').length - 1, 1, 'one call');
    const bind = main.indexOf('\nbindHostSessionRuntimeHooks(runtimeSelection);\n');
    assert.ok(bind > main.indexOf('\nconst runtimeSelection = createHostRuntimeSelection({\n'), 'a top-level call after the runtime selection');
    const remove = main.slice(main.indexOf('  deleteSession: lockSessionRoute(async (sessionId: string) => {'));
    const body = remove.slice(0, remove.indexOf('\n  }),\n'));
    assert.ok(body.indexOf("cleanupSessionRuntimeForTerminalStatus(sessionId, 'deleted');") > body.indexOf('await sessionStorage.delete(sessionId);'));
  });

  // 规则：Pi 包的退役钩子要拿到 Host 的 Maker（Maker 建好后 attach），Host 退出时关闭。
  // 失效后果：包变更后运行中的 Pi 任务不退役，或进程退出时留下监听。
  it('attaches the Pi packages to the Maker and closes them on teardown', () => {
    assert.ok(read(path.join(hostAgent, 'runtime.ts')).includes('  piPackages.attachMaker(maker);\n'));
    assert.ok(read(path.join(hostSrc, 'main.ts')).includes('    agentGraph?.piPackages.close();\n'));
  });

  // 规则：Host 退出时（且只在退出时）在 Maker 关闭之前收掉 Codex 工具进程树，与桌面退出时的同步阶段相同；
  // cc-debug 跟随与桌面同一个开关。失效后果：换账号时误杀进程，或退出后留下 Codex 工具进程。
  it('reaps the Codex tool trees on exit only, before the Maker shutdown, and follows the cc-debug switch', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    const bootstrap = read(path.join(desktopMain, 'bootstrap-electron.ts'));
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) sources.push(file);
      }
    };
    walk(hostSrc);
    const callers = sources.filter(file => read(file).includes('reapCodexToolTreesSync('));
    assert.deepEqual(callers, [path.join(hostSrc, 'main.ts')]);
    assert.equal(main.split('reapCodexToolTreesSync(').length - 1, 1);
    const stop = main.slice(main.indexOf('const stop = () => {'), main.indexOf("process.once('SIGINT', stop);"));
    assert.ok(stop.includes('reapCodexToolTreesSync();'));
    assert.ok(stop.indexOf('reapCodexToolTreesSync();') < stop.indexOf('await disposeOwnerRuntime();'));
    const dispose = main.slice(main.indexOf('async function disposeOwnerRuntime('));
    assert.equal(dispose.slice(0, dispose.indexOf('\n}\n')).includes('reapCodexToolTreesSync'), false);
    assert.match(bootstrap, /onQuit\(\s*'reap-codex-tool-trees',\s*\(\) => {\s*reapCodexToolTreesSync\(\);\s*},\s*'sync',\s*\);/);
    const tailer = "setCcDebugTailingEnabled(process.env.XDT_CC_DEBUG_NET === '1');";
    assert.ok(bootstrap.includes(tailer));
    assert.ok(main.indexOf(tailer) > main.indexOf("initLogger({ userDataDir: profileDir, isPackaged: true, logDir: path.join(profileDir, 'logs') });"));
  });

  // 规则：网关 key 被拒时，任务执行器经 main.ts 交给的这个入口重新同步。失效后果：被拒的 key 一直用下去。
  it('gives the input queue the gateway key rejection entry', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.ok(main.includes('  reportAgentCindyGatewayKeyRejected: () => modelAccess?.reportCurrentKeyRejected(),\n'));
  });

  // 规则：视觉桥在 Maker 关闭之后才关。失效后果：关闭途中还在跑的任务读图失败。
  it('closes the vision bridge after the Maker shuts down', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    const shutdown = main.indexOf('?.shutdown?.());');
    const close = main.indexOf('agentGraph?.visionBridge.close()');
    assert.ok(shutdown > 0 && close > shutdown, 'visionBridge.close() follows Maker shutdown in the runtime teardown');
  });

  // 规则：XD 快照的写入、未知标记与读取都走本进程共享的 active-catalog（放行表第二节 XD 快照）。
  // 失效后果：子代理准入、Codex 代理与辅助模型候选读到的快照与刷新写入的不是同一份。
  it('sends the catalog writes and the unknown mark to the shared active catalog', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.ok(main.includes('    setXdGatewayModels(models, options);\n'));
    assert.ok(main.includes('  markModelsUnknown: () => markXdGatewayModelAccessUnknown(),\n'));
    assert.ok(main.includes('  readModels: () => getXdGatewayModels(),\n'));
    assert.ok(main.includes('const parsed = parseModelsSyncPayload(payload);'));
  });

  // 规则：Claude 的 MCP 重名选择由 main.ts 从插件网关的读取构建，与桌面 Claude 构造点用同一族函数。
  // 失效后果：Host 上用户在窗口里选过的重名处理不生效。
  it('gives Claude the MCP duplicate choices built from the plugin gateway reads', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.ok(main.includes('resolveLocalMcpDuplicateChoices: createHostMcpDuplicateChoices(pluginGateway.customMcp).resolveLocalMcpDuplicateChoices,'));
    const desktop = read(desktopIndex);
    assert.ok(desktop.includes("import { resolveLocalMcpDuplicateChoices } from './mcp-duplicate-preferences.js';"));
    assert.ok(desktop.includes('    const claudeAgent = new ClaudeCodeAgent({\n      resolveLocalMcpDuplicateChoices,\n'));
  });

  // 规则：放行表第 13 行 3a。账号凭据的每个状态，model access 的 publish 既推给窗口，也交给目录的
  // noteCredentialStatus，照桌面 model-access/index.ts 的 onStatusChange（failed / disabled / unsupported / idle
  // 清价并挂起，ok 解除）。usage-pricing.test.mjs 照这一行接线来测，测不到 main.ts 本身。
  // 失效后果：凭据失败后 Host 继续答复失效账号的价格，恢复后也不会让目录过期重拉。
  it('hands every credential status the model access publishes to the provider catalog', () => {
    const access = call(read(path.join(hostSrc, 'main.ts')), 'modelAccess = createHostModelAccess(');
    const publish = access.slice(access.indexOf('publish:status=>'), access.indexOf(',onKeyChanged:'));
    assert.ok(publish.startsWith('publish:status=>{'), 'the publish callback');
    assert.ok(publish.includes("eventHub.publish({type:'plugin_push',channel:MODEL_ACCESS_STATUS_CHANNEL,payload:status});"));
    assert.ok(publish.includes('listProviders.noteCredentialStatus(status);'));
  });
});

describe('Host engine assembly (runtime.ts) against the desktop construction sites', () => {
  // 规则：Claude 的只读工具白名单与子代理用量三行与桌面构造点相同；Codex 凭证形态切换的参数同序；
  // 代理核心往进程级用量桥记账。失效后果：Host 上子代理用量丢失，或凭证切换前本机会话处置不同。
  it('has the three Claude lines, the credential mode switch arguments and the usage bridge', () => {
    const desktop = read(desktopIndex);
    const host = read(path.join(hostAgent, 'runtime.ts'));
    for (const line of [
      'claudeAllowedTools: getDesktopClaudeReadOnlyAllowedTools(),',
      'registerClaudeSubagentTask: (task) => claudeSubagentUsageBridge.registerTask(task),',
      'getClaudeSubagentTaskUsage: (taskId) => claudeSubagentUsageBridge.getTaskUsage(taskId),',
    ]) {
      assert.equal(desktop.split(line).length - 1, 1, `desktop: ${line}`);
      assert.equal(host.split(line).length - 1, 1, `host: ${line}`);
    }
    const args = (source: string) => {
      const start = source.indexOf('await prepareLocalCodexCredentialModeSwitch({');
      const body = source.slice(start, source.indexOf('});', start));
      return [...body.matchAll(/^\s+(\w+)(?::|,)/gm)].map(m => m[1]);
    };
    assert.deepEqual(args(desktop), ['maker', 'isSessionInTurn', 'hostKey', 'fromMode', 'fromModeEffective', 'toMode']);
    assert.deepEqual(args(host), args(desktop));
    const core = read(path.join(desktopMain, 'maker-host/anthropicCompatProxyHostCore.ts'));
    assert.ok(core.includes('createClaudeSubagentUsageResponseObserver(),'));
    assert.ok(core.includes('createClaudeSubagentUsageRequestTransform(),'));
  });

  // 规则：Claude 显式子代理模型的准入用 Host 的网关 key 与供应商视图（桌面用 resolveDesktopClaudeSubagentModelAccess）。
  // 失效后果：子代理模型准入与桌面不同。
  it('checks explicit Claude subagent models with the Host gateway key and provider views', () => {
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    assert.ok(runtime.includes([
      '    resolveClaudeSubagentModelAccess: createHostClaudeSubagentModelAccess({',
      '      readGatewayKey: () => options.gateway?.credential ?? null,',
      '      listProviderViews: () => config.publicViews(Boolean(options.gateway?.credential)),',
      '    }),',
    ].join('\n')));
    assert.ok(read(desktopIndex).includes('      resolveClaudeSubagentModelAccess: resolveDesktopClaudeSubagentModelAccess,\n'));
  });

  // 规则：Claude 的钩子（读图、Bash 并发闸门、电脑操作防护）与桌面构造点逐行相同，只换日志实例和插件注册表的取法。
  // 失效后果：Host 上的 Claude 任务少一道桌面有的防护。
  it('composes the Claude hooks as the desktop, line for line', () => {
    const desktop = read(desktopIndex);
    const host = read(path.join(hostAgent, 'runtime.ts'));
    const asHost = (text: string) => text.replaceAll('desktopMakerLogger', 'LOGGER').replaceAll('getPluginRegistry()', 'createPluginRegistry()');
    for (const start of ['createCommandConcurrencyGate({', 'mergeClaudeHooks(']) {
      assert.equal(call(host, start), asHost(call(desktop, start)), start);
    }
  });

  // 规则：Pi 的三个模型解析与全局上下文目录，是桌面 buildPiAgentForDesktop 的同几行，只换成 Host 的目录。
  // 失效后果：Host 上 Pi 列出的模型或读的全局上下文与桌面不同。
  it('resolves Pi models, descriptors and the global context home with the desktop lines', () => {
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    const desktop = read(desktopIndex);
    const piHost = read(piHostFile);
    const desktopModels = between(desktop, 'resolvePiRuntimeModels: () =>', 'mcpProviders: piMcpProviders,', true).replaceAll('getDesktopSelectableCatalog()', 'modelContext.getSelectableCatalog()');
    // The Host lists the three resolvers before its loopback-proxy line. (The unit test this came
    // from ended its Host slice at a marker that no longer occurred, so it compared nothing.)
    const hostModels = between(runtime, 'resolvePiRuntimeModels: () =>', 'registerPiProxySession: claudeProxy?.registerPiProxySession,', true);
    assert.equal(hostModels, desktopModels, 'the three model resolvers are the desktop lines');
    assert.equal(between(runtime, 'resolvePiGlobalContextHome: (remoteHostId) => {', '        },', true),
      between(piHost, 'resolvePiGlobalContextHome: (remoteHostId) => {', '    },', true));
  });

  // 规则：Pi 缓存兼容的存储路径与读取，是桌面 buildPiAgent 的同几行，落在同一个 profile 文件。
  // 失效后果：两边学到的缓存兼容互相看不见。
  it('keeps the Pi cache compatibility store in the desktop profile file, with the desktop lines', () => {
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    const piHost = read(piHostFile);
    assert.equal(between(runtime, 'resolvePiNativeCompatStorePath:', 'resolvePiNativeProviders:', true),
      between(piHost, 'resolvePiNativeCompatStorePath:', 'getManagedSkills:', true)
        .replaceAll("app.getPath('userData')", 'options.userDataDir')
        .replaceAll('readPiNativeCompatOverride(providerId', 'piNativeCompatOverrides.readPiNativeCompatOverride(providerId'));
    assert.ok(runtime.includes('const piNativeCompatOverrides = createPiNativeCompatOverridesStore({ app: { getPath: () => options.userDataDir } });'));
    assert.ok(runtime.includes("import { createPiNativeCompatOverridesStore } from '../../../desktop/src/main/maker-host/piNativeCompatOverridesStoreCore.js';"));
  });

  // 规则：Pi 的云端文件启动提示与扩展对话框文案，是桌面 buildPiAgent 的同几行，按系统语言取。
  // 失效后果：Host 上的提示文案与桌面不同（放行表第二节“Pi 提示与对话框的语言”）。
  it('formats the Pi startup hint and dialog strings with the desktop lines', () => {
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    const piHost = read(piHostFile);
    assert.equal(between(runtime, 'formatPiStartupCloudFileHint: (file) =>', 'resolvePiVisionBridgeEnv:'),
      between(piHost, 'formatPiStartupCloudFileHint: (file) =>', 'preparePiExtraSpawnConfig:'));
    assert.ok(runtime.includes('const { t } = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);'));
  });

  // 规则：Pi 判断 OpenAI 订阅时用 Codex 账号服务的判断（与桌面同一个 createCodexAccountAuth）。
  // 失效后果：Host 把目录里其他带原生 Codex 登录的供应商也算作 OpenAI 订阅。
  it('takes the OpenAI subscription predicate for Pi from the Codex account service', () => {
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    assert.ok(runtime.includes('    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),\n'));
  });

  // 规则：CodexAgent 的令牌读取是桌面 createCodexAuthTokenReader 的函数体，只把三处换成端口。
  // 失效后果：Host 上 Codex 订阅桥在会话边界或换 owner 时给出与桌面不同的令牌。
  it('reads the Codex auth token with the desktop createCodexAuthTokenReader body and three ports', () => {
    const desktop = read(desktopIndex);
    const host = read(path.join(hostAgent, 'codex-token-reader.ts'));
    const shape = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    const start = desktop.indexOf('      createCodexAuthTokenReader: (providerId) => {\n');
    assert.ok(start >= 0);
    const desktopBody = desktop.slice(desktop.indexOf('\n', start) + 1, desktop.indexOf('\n      },\n', start));
    const hostStart = host.indexOf('  return (providerId?: string) => {\n');
    const hostBody = host.slice(host.indexOf('\n', hostStart) + 1, host.indexOf('\n  };\n}', hostStart));
    assert.equal(shape(hostBody), shape(desktopBody)
      .replace('desktopCodexAuthAdapter.getState(', 'codexAuthAdapter.getState(')
      .replace('desktopCodexAuthAdapter.readOneShotCreds(providerId)', 'readOneShotCreds(providerId)')
      .replace('_codexAgent !== codexAgent', '!isCodexAgentCurrent()')
      .replaceAll('getActiveAuthRealm()', 'readAuthRealm()'));
    const runtime = read(path.join(hostAgent, 'runtime.ts'));
    for (const line of ['createCodexAuthTokenReader: createHostCodexAuthTokenReader({', 'codexAuthAdapter: codexAuth,',
      'readOneShotCreds: providerId => options.codexRuntime?.native.readOneShotCreds(providerId) ?? null,',
      'isCodexAgentCurrent: () => options.codexRuntime?.isCurrent() ?? false,', 'readAuthRealm: () => options.readAuthRealm?.() ?? null,']) {
      assert.ok(runtime.includes(line), line);
    }
  });

  // 规则：Codex 智能子代理路由带父任务的思考档位，与桌面同几行。失效后果：子代理的思考档位与桌面不同。
  it('registers the Codex smart subagent routes with the desktop lines', () => {
    const desktop = read(desktopIndex);
    const host = read(path.join(hostAgent, 'codex-runtime.ts'));
    const lines = (text: string, from: string, to: string) => {
      const start = text.indexOf(from);
      assert.ok(start >= 0, from);
      const end = text.indexOf(to, start);
      assert.ok(end > start, to);
      return text.slice(start, end).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    };
    const from = '...(subagentRoute ? { subagentRoute } : {}),';
    assert.equal(lines(host, from, 'getCodexSubagentIdentity:'), lines(desktop, from, 'getCodexSubagentIdentity:').replace(/\}\),$/, '});\n},'));
  });

  // 规则：Host 的 Codex 作废只收 maker-core 报来的那几个上下文字段；运行时把账号服务的判断传给作废。
  // 失效后果：作废时漏读上下文（误作废或该作废的没作废），或独立账号的失败作废了原生登录。
  it('invalidates Codex with only the context maker-core reports, and the account service predicate', () => {
    const source = (rel: string) => ts.createSourceFile(rel, read(path.join(repo, rel)), ts.ScriptTarget.ESNext, true);
    const members = (type: ts.TypeNode | undefined) => (type && ts.isTypeLiteralNode(type)
      ? type.members.map(member => member.name!.getText()).sort() : null);
    let core: string[] | null = null;
    let host: string[] | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isMethodSignature(node) && node.name.getText() === 'invalidate' && node.parameters.length === 2) core = members(node.parameters[1]!.type);
      if (ts.isVariableDeclaration(node) && node.name.getText() === 'invalidateNative' && node.initializer && ts.isArrowFunction(node.initializer)) {
        host = members(node.initializer.parameters[1]?.type);
      }
      ts.forEachChild(node, visit);
    };
    visit(source('packages/maker-core/src/interfaces/auth-adapter.ts'));
    visit(source('apps/host/src/agent/codex-runtime.ts'));
    assert.deepEqual(core, ['credentialAttribution', 'credentialGeneration', 'providerId']);
    assert.deepEqual(host, core);
    assert.ok(read(path.join(hostAgent, 'codex-runtime.ts'))
      .includes("isCodexAccountProvider: id => id !== 'openai' && options.config.codexAccounts.isCodexAccountProvider(id),"));
  });

  // 规则：工作树租约在共享 Skill 链接之前取、取后复查已取消的预建，与桌面启动钩子同几行；释放推迟的
  // 告警逐字相同。失效后果：回收 worktree 时删掉运行中任务的目录，或已取消的预建照常启动。
  it('takes the worktree lease with the desktop start-hook lines, before the shared Skill links', () => {
    const host = read(path.join(hostAgent, 'start-options.ts'));
    const desktop = read(desktopIndex);
    const block = (source: string, from: string) => {
      const start = source.indexOf(from);
      assert.ok(start >= 0, from);
      const end = source.indexOf('}', source.indexOf('assertPrecreatedSessionNotCancelled(sessionId);', start));
      return source.slice(start, end + 1).split('\n').map(line => line.trim()).join('\n');
    };
    const desktopBlock = block(desktop, 'if (!createOpts.remoteHostId && createOpts.workingDir) {\n            const lease');
    const hostBlock = block(host, 'if (!createOpts.remoteHostId && createOpts.workingDir) {')
      .replace('hostWorktreeRuntimeLeases.acquireWorktreeRuntimeLease(', 'acquireWorktreeRuntimeLease(')
      .replace('hostPrecreatedCancellation.assertPrecreatedSessionNotCancelled(', 'assertPrecreatedSessionNotCancelled(');
    assert.equal(hostBlock, desktopBlock);
    const prepare = host.slice(host.indexOf('async function prepareStartOptions('), host.indexOf('async function onBeforeStart('));
    assert.ok(prepare.indexOf('acquireWorktreeRuntimeLease(') < prepare.indexOf('prepareSharedProjectSkillLinks('));
    const desktopPrepare = desktop.slice(desktop.indexOf('const createOpts = opts as MakerSessionCreateOpts;'));
    assert.ok(desktopPrepare.indexOf('acquireWorktreeRuntimeLease(') < desktopPrepare.indexOf('prepareSharedProjectSkillLinks('));
    const warn = "'worktree runtime lease release postponed', { sessionId, code: (error as NodeJS.ErrnoException).code }";
    assert.equal(desktop.split(warn).length - 1, 3);
    assert.equal(host.split(warn).length - 1, 1);
  });
});

describe('Host copies of desktop expressions', () => {
  // 规则：权限请求离开 Host 前的工具输入脱敏，是桌面 boundaryRequest 的同一个表达式。
  // 失效后果：代理凭据等敏感输入经 Host 的事件流与设备互联外泄。
  it('redacts permission request tool input with the desktop expression', () => {
    const shape = (text: string) => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//')).join(' ');
    const desktop = read(path.join(desktopMain, 'maker-ipc/register.ts'));
    const host = read(path.join(hostAgent, 'interactions.mjs'));
    const cut = (text: string, from: string, to: string) => { const start = text.indexOf(from); assert.ok(start >= 0, from); return text.slice(start, text.indexOf(to, start)); };
    assert.equal(shape(cut(host, 'request.kind === \'permission\'', ': request;')),
      shape(cut(desktop, "req.kind === 'permission'", ': req;')).replaceAll('...req,', '...request,').replaceAll('req.', 'request.').replace(' as Record<string, unknown>', ''));
  });

  // 规则：Host 的生成图读来源（apps/host/src/agent/generated-images.ts 的 readSource）是 Host 自己的一份，
  // 照桌面 register.ts createDesktopGeneratedImageDelivery 的 readSource 写，去掉了 SSH 文件服务与旧的
  // xdt-image 两支（放行表第七节第 31 项）。这里钉住桌面那段的文本（去掉缩进、空行与注释后的 sha256）。
  // 失效后果：桌面改了读来源的次序、回落或限制，Host 那份不跟着改，同一张图在两边读法不同。
  // 变红时：对照桌面新文本改 Host 那份（或在第 31 项写明为什么不跟），再更新这里的指纹。
  it('pins the desktop generated-image readSource that the Host copy follows', () => {
    const desktop = read(path.join(desktopMain, 'maker-ipc/register.ts'));
    const text = between(desktop, 'readSource: async (_sessionId, image, session) => {', 'setGeneratedImageRecovery((sessionId)');
    const fingerprint = createHash('sha256').update(text).digest('hex');
    expect(fingerprint, 'register.ts readSource changed: compare apps/host/src/agent/generated-images.ts readSource '
      + '(release table section 7, item 31), then update this fingerprint').toBe(
      '0cb159a4a79191099771e36a47a9157da6d63ad9f41d1221c8d60130e139536f');
  });

  // 规则：Host 的 deliverCodexGeneratedImage（apps/host/src/agent/generated-images.ts）与桌面 register.ts 的
  // 同名函数逐行相同，只有交付实例的名字不同（放行表第七节第 32 项）。
  // 失效后果：一边改了开始交付、失败记录或交出事件的方式，另一边没跟上。
  it('starts a live generated-image delivery with the desktop function, line for line', () => {
    const signature = 'function deliverCodexGeneratedImage(sessionId: string, event: AgentEvent): Promise<readonly AgentEvent[]> {';
    const desktop = between(read(path.join(desktopMain, 'maker-ipc/register.ts')), signature, '\nfunction broadcastSyntheticToolEvent(');
    const host = between(read(path.join(hostAgent, 'generated-images.ts')), signature, 'return { delivery, deliverCodexGeneratedImage };');
    assert.ok(desktop.split('\n').length > 8);
    expect(host, 'compare apps/host/src/agent/generated-images.ts with register.ts deliverCodexGeneratedImage '
      + '(release table section 7, item 32)').toBe(desktop.replaceAll('generatedImageDelivery.start(', 'delivery.start('));
  });

  // 规则：Host 的静默停止排期（apps/host/src/agent/silent-stop.ts 的 schedule）照桌面回合观察的终态分支写：
  // 当前代次的静默停止终态排一次决策、重复的不再排，并留住这一代次给续跑（放行表第七节第 36 项）。这里钉住桌面那段的
  // 文本（去掉缩进、空行与注释后的 sha256）。
  // 失效后果：桌面改了排期或留住代次的条件，Host 那份不跟着改，静默停止在两边续不续、何时被丢弃不同。
  // 变红时：对照桌面新文本改 Host 的 schedule（或在第 36 项写明为什么不跟），再更新这里的指纹。
  it('pins the desktop silent-stop terminal scheduling that the Host copy follows', () => {
    const text = between(read(path.join(desktopMain, 'maker-ipc/sessionTurnObserver.ts')), 'const isSilentStop =',
      'if (isCurrentGeneration) deps.silentStopTurnLeaseGate.supersede(session.id);');
    const fingerprint = createHash('sha256').update(text).digest('hex');
    expect(fingerprint, 'sessionTurnObserver.ts silent-stop terminal changed: compare apps/host/src/agent/silent-stop.ts schedule '
      + '(release table section 7, item 36), then update this fingerprint').toBe(
      'c5c91ef223262768c2b9dd12b137e0a70a82711985cc8618646a03c3488bae0b');
  });

  // 规则：Host 的静默停止决策时机（silent-stop.ts 的 decideLater，以及 turn-executor.mjs 对静默停止 done 不收尾、
  // 不交给协调器、延后结算改动记录）照桌面事件准备的静默停止分支写（放行表第七节第 36 项）。钉住桌面那段的文本。
  // 失效后果：桌面改了静默停止 done 的处理或决策的延时，Host 那份不跟着改。
  // 变红时：对照桌面新文本改 Host 那份（或在第 36 项写明为什么不跟），再更新这里的指纹。
  it('pins the desktop silent-stop decision timing that the Host copy follows', () => {
    const text = between(read(path.join(desktopMain, 'maker-ipc/sessionEventPreparation.ts')), 'const carriesSilentStop =',
      '}, SILENT_STOP_DECISION_DELAY_MS);');
    const fingerprint = createHash('sha256').update(text).digest('hex');
    expect(fingerprint, 'sessionEventPreparation.ts silent-stop branch changed: compare apps/host/src/agent/silent-stop.ts decideLater '
      + 'and the silent-stop done in turn-executor.mjs (release table section 7, item 36), then update this fingerprint').toBe(
      '26b5e363262ad7e18d1b5f2cc350fe39a6b158ea4af6519ae54e7a290e1f887e');
  });

  // 规则：视觉桥的提示文案与去重时间，是桌面 broadcastVisionBridgeEvent 的同一段。
  // 失效后果：Host 上的视觉桥提示与桌面不同或重复弹出。
  it('sends the vision bridge notices with the desktop text and dedup', () => {
    const desktop = read(desktopIndex);
    const hostSource = read(path.join(hostAgent, 'vision-bridge.ts'));
    const body = (source: string) => {
      const start = source.indexOf("if (reason === 'vision-bridge-recognizing') {");
      const end = source.indexOf("source: 'vision-bridge',", start);
      return source.slice(start, end).replace(/\s+/g, '');
    };
    assert.ok(body(desktop).length > 200);
    assert.equal(body(hostSource), body(desktop));
    assert.ok(hostSource.includes('const VISION_BRIDGE_DEDUP_MS = 2_000;'));
    assert.ok(desktop.includes('const VISION_BRIDGE_DEDUP_MS = 2_000;'));
  });

  // 规则：Host 的 Pi 持久子代理入口与桌面入口逐行相同，只有 ready 帧的发法、断开通道和父进程监视不同。
  // 失效后果：Host 上的 runner 行为与桌面分叉（P4、m1-cp18c 审核方定乙）。
  it('starts the Pi subagent runner with the desktop entry, except the ready frame, the channel and the watchdog', () => {
    const lines = (file: string) => read(file).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
    const desktop = lines(path.join(desktopMain, 'cindy-brain/piSubagentRunnerProcess.ts'));
    const host = lines(path.join(hostAgent, 'pi-subagent-runner-process.cts'));
    assert.deepEqual(desktop.filter(line => !host.includes(line)), [
      'interface ParentPortLike {',
      'postMessage(message: unknown): void;',
      'const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;',
      "if (!parentPort) throw new Error('PI Subagent runner process is missing parentPort');",
      "parentPort.postMessage({ type: 'ready' });",
      'try {',
      "Object.defineProperty(process, 'parentPort', {",
      'configurable: true,',
      'value: undefined,',
      '} catch {',
    ]);
    assert.deepEqual(host.filter(line => !desktop.includes(line)), [
      "import { startParentWatchdog } from './pi-subagent-parent-watchdog.cjs';",
      'const send = process.send?.bind(process);',
      'const hostPid = process.ppid;',
      "if (!send) throw new Error('PI Subagent runner process is missing its IPC channel');",
      "send({ type: 'ready' }, (error: Error | null) => {",
      'if (error) throw error;',
      'process.disconnect?.();',
      'startParentWatchdog({',
      'parentPid: hostPid,',
      'onParentGone: () => {',
      'setTimeout(() => process.exit(1), 5_000);',
      "process.kill(process.pid, 'SIGTERM');",
      '},',
    ]);
  });

  // 规则：/learn 捕获对照测试里照抄的桌面依赖，与 register.ts 实际传的逐行相同。
  // 失效后果：对照测试比较的不再是桌面真实的依赖，“已对齐”的证据失效。
  it('keeps the /learn capture parity copy equal to what register.ts passes', () => {
    const after = (text: string, start: string, end: string) => {
      const from = text.indexOf(start);
      assert.ok(from >= 0, start);
      const to = text.indexOf(end, from + start.length);
      assert.ok(to > from, end);
      return text.slice(from + start.length, to).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    };
    const register = read(path.join(desktopMain, 'maker-ipc/register.ts'));
    const desktopDeps = after(register, 'captureCindyLearnInvocation: createCindyLearnInvocationCapture({', '\n    }),\n    createDbMessage:');
    const copied = after(read(path.join(desktopMain, 'learn-host/__tests__/hostLearnCaptureParity.test.ts')), '  desktop = createCindyLearnInvocationCapture({', '\n  }) as Capture;');
    assert.ok(desktopDeps.length > 0);
    assert.equal(copied, desktopDeps);
  });

  // 规则：cindy_memory 每次调用前的账号数据检查（Host `hostAccountDataAccess`）与 session_search 的调用方
  // 检查（Host `createHostSessionSearch`），照抄桌面 mcp-providers.ts 里的两段内联闭包（`withAccountDataAccess`、
  // memory 依赖的 `searchSessions`；放行表第七节第 26、25 项）。两段都内联在桌面的 provider 装配里
  // （`searchSessions` 在 createLiziMcpProviders 的参数里），pluginTaskHelperScope.test.ts 按源码截取它们来测，
  // 暂时不能搬成共用。
  // 失效后果：桌面收紧了检查而 Host 没跟上，Host 的记忆工具悄悄比桌面松（换账号后上一个账号的任务读写数据）。
  // 缺口：Host 的行为测试（memory.test.mjs）只验证现有的几种拒绝，看不到桌面以后加的检查。
  // 最小失败输入：Host 副本里任一行与桌面不同。比较去掉缩进、空行与注释；session_search 只允许检索那一处不同。
  it('keeps the cindy_memory caller checks line for line with the desktop closures', () => {
    const fn = (file: string, pick: (node: ts.Node) => ts.Node | undefined) => {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true);
      const found: (ts.ArrowFunction | ts.FunctionDeclaration)[] = [];
      const visit = (node: ts.Node) => {
        const hit = pick(node);
        if (hit && (ts.isArrowFunction(hit) || ts.isFunctionDeclaration(hit))) found.push(hit);
        ts.forEachChild(node, visit);
      };
      visit(source);
      assert.equal(found.length, 1, file);
      const [hit] = found;
      const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
      return { params: hit.parameters.map(p => p.getText(source)).join(', '), body: lines(hit.body!.getText(source)) };
    };
    const named = (node: ts.Node, name: string) => (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isFunctionDeclaration(node))
      && node.name?.getText() === name;
    const desktopFile = path.join(desktopMain, 'mcp-integrations/mcp-providers.ts');
    const hostFile = path.join(hostAgent, 'memory-mcp-ports.ts');

    const desktopAccess = fn(desktopFile, node => named(node, 'withAccountDataAccess') && ts.isVariableDeclaration(node) ? node.initializer : undefined);
    const hostAccess = fn(hostFile, node => named(node, 'hostAccountDataAccess') ? node : undefined);
    assert.ok(desktopAccess.body.length > 10);
    assert.equal(hostAccess.params, desktopAccess.params);
    assert.deepEqual(hostAccess.body, desktopAccess.body);

    const desktopSearch = fn(desktopFile, node => named(node, 'searchSessions') && ts.isPropertyAssignment(node) ? node.initializer : undefined);
    const hostSearch = fn(hostFile, node => ts.isReturnStatement(node) && node.parent.parent && named(node.parent.parent, 'createHostSessionSearch')
      ? node.expression : undefined);
    // The one difference: the search runs on the shared core with this Host's device id.
    const search = new Map([
      ['const hits = await searchSessionsWithBotScopeCore(query, opts, {', 'const hits = await searchSessionsWithBotScope(query, opts, {'],
      ['botAccountWide: await input.readsAccountHistory(opts.callerSessionId),', 'botAccountWide: await botReadsAccountHistory(opts.callerSessionId),'],
    ]);
    assert.ok(desktopSearch.body.length > 10);
    assert.equal(hostSearch.params, desktopSearch.params);
    assert.deepEqual(hostSearch.body.filter(line => line !== 'readDeviceId: input.deviceId,').map(line => search.get(line) ?? line), desktopSearch.body);
  });

  // 规则：并存方案 A（审核方 2026-11-17）。闸门关着时，Host 交给订阅桥的登录端口拒绝桥会提前续期的令牌
  // （apps/host/src/agent/codex-runtime.ts 的 BRIDGE_REFRESH_MARGIN_SEC），这个秒数照抄桥自己的续期提前量
  // （anthropicResponsesBridgeHostCore.ts 的 REFRESH_MARGIN_SEC）。失效后果：桥的提前量改大而 Host 没跟上时，
  // 闸门关着时 Host 会放行一个桥随后就续期的令牌，续期结果写回桌面也在用的登录文件；改小时 Host 会拒掉桥不会续期的令牌。
  it('refuses the tokens the subscription bridge would renew, with the bridge\'s own margin', () => {
    const bridge = /^const REFRESH_MARGIN_SEC = (\d+);$/m.exec(read(path.join(desktopMain, 'maker-host/anthropicResponsesBridgeHostCore.ts')))?.[1];
    const host = /^export const BRIDGE_REFRESH_MARGIN_SEC = (\d+);$/m.exec(read(path.join(hostAgent, 'codex-runtime.ts')))?.[1];
    assert.ok(bridge, 'REFRESH_MARGIN_SEC is declared in anthropicResponsesBridgeHostCore.ts');
    assert.ok(host, 'BRIDGE_REFRESH_MARGIN_SEC is declared in apps/host/src/agent/codex-runtime.ts');
    assert.equal(host, bridge, `桥的续期提前量是 ${bridge} 秒，Host 的 BRIDGE_REFRESH_MARGIN_SEC 是 ${host} 秒：两边要一起改`);
  });

  // 规则：并存方案 A（审核方 2026-11-17）。闸门关着时，Host 的 xAI 登录包装拒绝 Grok 服务会提前续期的令牌
  // （apps/host/src/agent/xai-held-login.ts 的 GROK_REFRESH_MARGIN_SEC），这个秒数照抄 grok-oauth-login.ts 的 REFRESH_MARGIN_SEC。
  // 失效后果：服务的提前量改大而 Host 没跟上时，闸门关着时 Host 会放行一个服务随后就续期的令牌，续期结果写回桌面也在用的 safe-storage。
  it('refuses the xAI tokens the Grok service would renew, with the service\'s own margin', () => {
    const service = /^const REFRESH_MARGIN_SEC = (\d+);$/m.exec(read(path.join(desktopMain, 'maker-host/grok-oauth-login.ts')))?.[1];
    const host = /^export const GROK_REFRESH_MARGIN_SEC = (\d+);$/m.exec(read(path.join(hostAgent, 'xai-held-login.ts')))?.[1];
    assert.ok(service, 'REFRESH_MARGIN_SEC is declared in grok-oauth-login.ts');
    assert.ok(host, 'GROK_REFRESH_MARGIN_SEC is declared in apps/host/src/agent/xai-held-login.ts');
    assert.equal(host, service, `Grok 服务的续期提前量是 ${service} 秒，Host 的 GROK_REFRESH_MARGIN_SEC 是 ${host} 秒：两边要一起改`);
  });
});

// 以下断言原在桌面普通单测里读 register.ts；第一批桌面准备把被守护的代码原样搬进共用文件
// （interruptedTurnAutoResumeHooks.ts、silentStopTurnEnd.ts），Host 之后直接调用这些文件。断言随代码
// 改读新文件，按测试规范从普通单测移到这里，每条的意思不变；register.ts 一侧的接线断言留在原文件。
describe('shared turn files moved out of register.ts', () => {
  const autoResumeHooksSource = read(path.join(desktopMain, 'maker-ipc/interruptedTurnAutoResumeHooks.ts'));
  const silentStopTurnEndSource = read(path.join(desktopMain, 'maker-ipc/silentStopTurnEnd.ts'));

  // 原在 interruptedContinuationContract.test.ts “keeps a scheduler auto-resume owned until dispatch and fails it
  // when discarded”。规则：定时任务的自动续接在派发前一直归它所有，被丢弃时以 deferredOwner 收尾。
  // 失效后果：定时任务的续接在派发前就被清掉，或被丢弃后留在待定状态。
  it('keeps a scheduler auto-resume owned until dispatch and fails it when discarded', () => {
    const scheduleStart = autoResumeHooksSource.indexOf('autoResumeBookkeeping.schedule(');
    const scheduleEnd = autoResumeHooksSource.indexOf('onUnconfirmedAutoResumeTurn:', scheduleStart);
    expect(scheduleStart).toBeGreaterThan(-1);
    expect(scheduleEnd).toBeGreaterThan(scheduleStart);
    const scheduleHook = autoResumeHooksSource.slice(scheduleStart, scheduleEnd);
    expect(scheduleHook).not.toMatch(/clearSchedulerAutoResumePending\s*\(/);
    expect(scheduleHook).toMatch(/\(attempt\)\s*=>\s*\{\s*return\s*\(async/);
    expect(scheduleHook).not.toMatch(/void\s*\(async\s*\(\)\s*=>/);

    const ownerDiscardedStart = autoResumeHooksSource.indexOf('onResumableTurnErrorDiscarded: (');
    const ownerDiscardedEnd = autoResumeHooksSource.indexOf('onResumableTurnError: (', ownerDiscardedStart);
    expect(autoResumeHooksSource.slice(ownerDiscardedStart, ownerDiscardedEnd)).toMatch(
      /deferredOwner:\s*options\.owner/,
    );
  });

  // 原在 makerEventHotPathOrdering.test.ts “keeps auto-resume-owned terminal errors out of Agent Island until they
  // are final”与“preserves continuation-only retry across its exact unexpected provider rebuild”。规则：过期的续接
  // 不再重试；只续接型的续接记下预期的那一次重建；未确认的续接放弃持久化的那一份。失效后果：过期续接重复发送，
  // 或只续接型的续接在重建后丢失。
  it('keeps the auto-resume hooks\' attempt, rebuild and unconfirmed-turn steps', () => {
    expect(autoResumeHooksSource).toContain('if (!attempt.isCurrent()) {');
    expect(autoResumeHooksSource).toContain('if (isContinuationOnlyAutoResumeReason(signals.reason)) {');
    expect(autoResumeHooksSource).toContain(
      'pendingContinuationOnlyAutoResumeRebuilds.set(runtimeSession, decision.attemptToken);',
    );
    expect(autoResumeHooksSource).toContain('autoResumeBookkeeping.abandonUnconfirmedPersistedResume(');
  });

  // 原在 makerEventHotPathOrdering.test.ts “preserves the product clock before a silent-stop continuation can emit
  // running”。规则：静默停止续接发出前先保住这一轮的计时。失效后果：续接一开始就把用时清零。
  it('preserves the product clock before a silent-stop continuation can emit running', () => {
    const start = silentStopTurnEndSource.indexOf('export async function handleSilentStopTurnEndWithPorts(');
    const continuation = silentStopTurnEndSource.slice(start);
    const first = continuation.indexOf('productTurnWallClockTracker.preserveForContinuation(session.id);');
    const second = continuation.indexOf('const sendResult = await session.sendHostTurnContinuation(');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
  });

  // 原在 silentStopContinuationBinding.test.ts “binds the reserved generation via the extracted helper and rolls back
  // on send failure”。规则：续接预约的代次经 helper 绑定，sendOpts 并入续接调用，未派发与抛出两条失败都回滚。
  // 失效后果：续接失败后代次留着，后面的终止事件被当成过期丢掉。
  it('binds the reserved generation via the extracted helper and rolls back on send failure', () => {
    const start = silentStopTurnEndSource.indexOf('export async function handleSilentStopTurnEndWithPorts(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = silentStopTurnEndSource.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    const resumeBlock = silentStopTurnEndSource.slice(start, end);
    expect(resumeBlock).toContain('bindSilentStopContinuationGeneration(session.id');
    expect(resumeBlock).toContain('...binding.sendOpts,');
    expect(resumeBlock.match(/binding\.rollbackBinding\(\);/g)).toHaveLength(2);
  });
});

// handleSetModel moved verbatim out of register.ts into maker-ipc/sessionRuntimeSelectionApply.ts (the
// Node Host runs the same steps). The two contracts below were ordinary unit tests reading register.ts;
// they now read the moved code and live here (test tier rules), each assertion unchanged.
describe('runtime selection moved out of register.ts', () => {
  const registerSource = read(path.join(desktopMain, 'maker-ipc/register.ts'));
  const runtimeSelectionApplySource = read(path.join(desktopMain, 'maker-ipc/sessionRuntimeSelectionApply.ts'));

  // Was in sessionRuntimeFallbackIntent.test.ts. Rule: an automatic same-engine change yields to a
  // user's pending choice before it writes or reconciles. Failure: an automatic change overwrites the
  // route the user just picked.
  it('uses the same guard before every automatic same-engine mutation can write or reconcile', () => {
    const start = runtimeSelectionApplySource.indexOf('  const handleSetModel = async (');
    const body = runtimeSelectionApplySource.slice(start, runtimeSelectionApplySource.indexOf('      const routeExplicit =', start));
    expect(body).toMatch(/internalOptions.source !== 'user' &&\s*!canApplyAutomaticRuntimeSelection\(sessionId, internalOptions.expectedGeneration\)/);
    expect(body).toContain('return { deferred: false, superseded: true };');
  });

  // Was in orcaProviderRoutingSnapshotWiring.test.ts. Rule: a task on an SSH host cannot switch to a
  // local-only account, refused before the selection is deferred or the running route replaced.
  // Failure: an SSH worker is moved onto a provider that only exists on this computer.
  it('rejects SSH account switching before deferring or replacing the running route', () => {
    const guard = runtimeSelectionApplySource.indexOf("throwIpcError('INVALID_PARAMS', 'This provider requires local execution')");
    expect(guard).toBeGreaterThan(-1);
    expect(runtimeSelectionApplySource.slice(guard - 450, guard)).toContain('runtimeStatus.remoteHostId');
    expect(runtimeSelectionApplySource.slice(guard - 300, guard)).toContain('isLocalOnlyProviderForAgent');
    expect(runtimeSelectionApplySource.indexOf('const deferLockedSelection =', guard)).toBeGreaterThan(guard);
    expect(runtimeSelectionApplySource.indexOf('const previousRuntime =', guard)).toBeGreaterThan(guard);
  });

  // Rule: createHandleSetModel's ports are bound when each call starts; the body used to read these
  // three register.ts variables at each use. That is the same only while each is assigned once, at
  // startup, before the set-model handler is registered. Failure: a later reset (an account switch,
  // say) reaches a call already running with the old value.
  // Rule: the pending credential switch service's assembly (pendingCredentialSwitchAssembly.ts) takes
  // agentInputCoordinatorHolder by value, which is the same only while register.ts assigns it once,
  // before that assembly. Failure: persistRoute refreshes the queued route of a stale coordinator or
  // of none.
  it('assigns the input coordinator holder before the pending credential switch service is assembled', () => {
    const assigned = registerSource.indexOf('\n  agentInputCoordinatorHolder = ');
    const assembled = registerSource.indexOf('const pendingCredentialSwitchService = createPendingCredentialSwitchService({');
    expect(assigned).toBeGreaterThan(-1);
    expect(assembled).toBeGreaterThan(assigned);
  });

  it('assigns each runtime-selection holder once in register.ts', () => {
    for (const holder of ['contextOverflowRolloverHolder', 'pendingCredentialSwitchHolder', 'agentInputCoordinatorHolder']) {
      const assignments = registerSource.match(new RegExp(`(^|[^.\\w])${holder}\\s*=(?!=)`, 'gm')) ?? [];
      // the one assignment (the declaration `let holder: … | null = null` does not match)
      expect(assignments, holder).toHaveLength(1);
    }
    const handler = registerSource.indexOf('registerSessionSetModelHandler(makerSessionRegistry, {');
    expect(handler).toBeGreaterThan(-1);
    for (const holder of ['contextOverflowRolloverHolder', 'pendingCredentialSwitchHolder', 'agentInputCoordinatorHolder']) {
      const assigned = registerSource.indexOf(`\n  ${holder} = `);
      expect(assigned, holder).toBeGreaterThan(-1);
      expect(assigned, holder).toBeLessThan(handler);
    }
  });
});

/**
 * The event types the desktop's event pipeline acts on, each classified for the Node Host.
 *
 * Rule: the desktop decides per event type in its pipeline (sessionEventPreparation.ts, sessionEventDelivery.ts,
 * sessionEventTerminal.ts) and in register.ts's emitWiredSessionEvent; the Host's executor
 * (apps/host/src/agent/turn-executor.mjs) is a separate implementation, so a new event type handled on the
 * desktop does not reach the Host unless someone classifies it. Each type here is either aligned on the Host
 * (where), a gap the release table records (which row), or a platform difference. The Host locations and
 * rows are those of the integration branch (cindy/host-m1); they ship with the Host PR.
 * Failure: a new type the desktop starts acting on, or a type it stopped acting on, turns this red until the
 * table is updated. It cannot see a new effect added to an existing type; the release table's event
 * inventory (A7) records those.
 */
describe('event types the desktop pipeline acts on, classified for the Host', () => {
  const EVENT_TYPE_PARITY: Record<string, { host?: string; gaps?: string[]; platform?: string }> = {
    account_usage: { gaps: ['row 13 (Codex account_usage snapshot)'] },
    agent_task_update: { host: 'turn-executor.mjs noteBackgroundActivity; history.event (sessionEventStreamCore, shared)' },
    compact_boundary: { host: 'turn-executor.mjs wireNotes.reset' },
    done: {
      host: 'turn-executor.mjs finish: flush, Codex plan, change record, Git savepoint, turn end',
      gaps: ['A9 turn-end seal', 'A10 last activity', 'A13 list preview and pinned summary', 'checkpoint 4 and 5 (auto-resume)'],
    },
    error: {
      host: 'turn-executor.mjs finish: error row, Codex plan failure, change record partial, Git abort; context recovery claim; claudeOpusPlanTerminalErrorData (sessionEventPreparationSteps.ts, shared)',
      gaps: ['checkpoint 4 (terminal to the coordinator first, auto-resume)'],
    },
    image: { host: 'turn-executor.mjs deliverCodexGeneratedImage (agent/generated-images.ts over the shared generatedImageDelivery.ts)' },
    interaction_dismissed: { host: 'turn-executor.mjs handleInteractionDismissedEvent (sessionEventPreparationSteps.ts, shared), in or out of a turn' },
    plan_mode_changed: { host: 'turn-executor.mjs persistAgentPlanModeChange (shared persistAgentPlanModeChangeWith)' },
    status: {
      host: 'turn-executor.mjs context snapshot (shared), background activity',
      gaps: ['smaller difference: running=false alone does not write the turn end time'],
    },
    text: { host: 'history.event (sessionEventStreamCore, shared); turn-executor.mjs routeStandaloneTextEvent (sessionEventPreparationSteps.ts, shared)' },
    turn_diff: { host: 'turn-executor.mjs noteTurnDiffEvent, not published' },
  };

  /** String literals compared with `<x>.type` (=== or !==) or used as `case` of a switch on `<x>.type`. */
  function eventTypesIn(source: string, name: string): Set<string> {
    const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const isTypeAccess = (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.name.text === 'type';
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
        if (isTypeAccess(node.left) && ts.isStringLiteral(node.right)) found.add(node.right.text);
        if (isTypeAccess(node.right) && ts.isStringLiteral(node.left)) found.add(node.left.text);
      }
      if (ts.isSwitchStatement(node) && isTypeAccess(node.expression)) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) found.add(clause.expression.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it('every event type the pipeline acts on is in the table, and every table entry is still acted on', () => {
    const ipc = path.join(desktopMain, 'maker-ipc');
    const register = read(path.join(ipc, 'register.ts'));
    const wiredStart = register.indexOf('const emitWiredSessionEvent');
    expect(wiredStart, 'emitWiredSessionEvent in register.ts').toBeGreaterThan(-1);
    const wired = register.slice(wiredStart, register.indexOf('\n  };\n', wiredStart) + 5);
    const acted = new Set<string>();
    for (const file of ['sessionEventPreparation.ts', 'sessionEventPreparationSteps.ts', 'sessionEventDelivery.ts', 'sessionEventTerminal.ts']) {
      for (const type of eventTypesIn(read(path.join(ipc, file)), file)) acted.add(type);
    }
    for (const type of eventTypesIn(wired, 'emitWiredSessionEvent')) acted.add(type);
    expect([...acted].sort()).toEqual(Object.keys(EVENT_TYPE_PARITY).sort());
    for (const [type, entry] of Object.entries(EVENT_TYPE_PARITY)) {
      expect(Boolean(entry.host || entry.gaps?.length || entry.platform), `${type} is classified`).toBe(true);
    }
  });
});

// Rule: AgentDeps is one interface for the three engines, and the Host writes every optional port of
// each engine's bag out (runtime.ts, explicitPorts). The ports only another engine reads are written
// once, in apps/host/src/agent/agent-deps-engines.ts, grouped by which engines read them. That grouping
// was read off maker-core by hand. If an engine later starts reading a port grouped as another engine's,
// the Host's bag for it keeps `undefined` there and nothing fails; this recomputes the grouping from the
// agents' source and compares. Failure: a port the engine now reads stays unbound on the Host.
describe('the Host\'s grouping of AgentDeps ports by the engines that read them', () => {
  const coreAgents = path.join(repo, 'packages/maker-core/src/agents');
  const ENGINES = { 'claude-code': 'claude', codex: 'codex', pi: 'pi' } as const;
  type Engine = (typeof ENGINES)[keyof typeof ENGINES];
  const BAGS: Record<string, Engine[]> = {
    PORTS_ONLY_CODEX_READS: ['codex'],
    PORTS_ONLY_PI_READS: ['pi'],
    PORTS_ONLY_CLAUDE_READS: ['claude'],
    PORTS_ONLY_CLAUDE_AND_PI_READ: ['claude', 'pi'],
    PORTS_ONLY_CLAUDE_AND_CODEX_READ: ['claude', 'codex'],
  };

  /**
   * The AgentDeps members a file reads: `deps.x`, `this.deps.x` (also with `?.`), and names destructured
   * from either. Read from the syntax tree, so a port named in a comment or a string is not a read.
   */
  function readsIn(file: string): Set<string> {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const isDeps = (node: ts.Expression) => (ts.isIdentifier(node) && node.text === 'deps')
      || (ts.isPropertyAccessExpression(node) && node.name.text === 'deps' && node.expression.kind === ts.SyntaxKind.ThisKeyword);
    const names = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && isDeps(node.expression)) names.add(node.name.text);
      if (ts.isVariableDeclaration(node) && node.initializer && isDeps(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key)) names.add(key.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  }
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(full);
      return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [full] : [];
    });
  }
  function optionalAgentDepsPorts(): string[] {
    const file = path.join(coreAgents, 'base-agent.ts');
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const decl = source.statements.find((node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'AgentDeps');
    assert.ok(decl, 'AgentDeps');
    return decl.members.filter(member => member.questionToken && member.name && ts.isIdentifier(member.name))
      .map(member => (member.name as ts.Identifier).text);
  }
  function hostBags(): Record<string, string[]> {
    const file = path.join(hostAgent, 'agent-deps-engines.ts');
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const bags: Record<string, string[]> = {};
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Expression = node.initializer;
        while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) init = init.expression;
        if (ts.isObjectLiteralExpression(init)) {
          bags[node.name.text] = init.properties.map(property => (property.name as ts.Identifier).text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return bags;
  }

  it('matches the engines that read each port in maker-core', () => {
    const ports = optionalAgentDepsPorts();
    // A port the base agent reads (base-agent.ts) is read by all three engines. Only agents/ is read:
    // maker.ts reads MakerDeps, whose own `toolLoopReviewer` is not the AgentDeps member of that name
    // (the Claude agent reads that one; Codex and Pi take Maker's).
    const sources = [
      { engines: ['claude', 'codex', 'pi'] as Engine[], files: [path.join(coreAgents, 'base-agent.ts'), ...files(path.join(coreAgents, 'shared'))] },
      ...Object.entries(ENGINES).map(([dir, engine]) => ({ engines: [engine] as Engine[], files: files(path.join(coreAgents, dir)) })),
    ].map(entry => ({ ...entry, reads: new Set(entry.files.flatMap(file => [...readsIn(file)])) }));
    const readers = new Map<string, Set<Engine>>(ports.map(port =>
      [port, new Set(sources.filter(source => source.reads.has(port)).flatMap(source => source.engines))]));
    const expected: Record<string, string[]> = Object.fromEntries(Object.entries(BAGS).map(([bag, engines]) => [bag,
      ports.filter(port => { const set = readers.get(port)!; return set.size === engines.length && engines.every(e => set.has(e)); }).sort()]));
    const actual = Object.fromEntries(Object.entries(hostBags()).map(([bag, keys]) => [bag, [...keys].sort()]));
    expect(actual).toEqual(expected);
    // Every optional port is read by some engine; one read by none would be grouped nowhere.
    expect(ports.filter(port => readers.get(port)!.size === 0)).toEqual([]);
  });
});

// 测试价值
// - 生产入口与可观察结果：桌面的 XD 报价投影（usage/modelPricing.ts）与账本币种存储
//   （usage/accountCurrencyStore.ts）。这两个壳在模块加载时各建一个工厂实例，桌面的用量记账、价格显示
//   与币种读写都经这一个实例。
// - 规则依据：放行表第 13 行 3a（7727009edb）。这次把 modelPricing / accountCurrencyStore 的模块级状态
//   （内存报价、磁盘缓存作用域、在途同步、当前账号与币种）搬进 createModelPricing /
//   createAccountCurrencyStore。搬移前后等价的前提是，整个桌面进程里各只有一个实例。
// - 现有覆盖缺口：modelPricing.test.ts 与 accountCurrencyStore.test.ts 只测壳建出的那个实例，测不到
//   别处再建一个。这是算钱的代码：第二个实例有自己的报价与币种，按它记的账会悄悄用旧价或错币种，
//   而且没有测试会失败。
// - 最小失败输入：桌面生产代码（apps/desktop/src，不含 __tests__、__mocks__、*.test.*、*.spec.*）里任意
//   一处多出的调用，包括：
//   - 别名导入；
//   - 命名空间导入后再调用；
//   - 把工厂当作值传出去；
//   - 在壳里的函数体内调用（每调用那个函数一次就多一个实例）。
// - tier：guard。读生产源码文本，属于跨文件静态契约，不能从生产入口隔离。
// - 实测耗时：见交付记录。
describe('the desktop builds one instance of each usage pricing factory', () => {
  const desktopSrc = path.join(repo, 'apps/desktop/src');
  const FACTORIES: Record<string, string> = {
    createModelPricing: 'main/usage/modelPricing.ts',
    createAccountCurrencyStore: 'main/usage/accountCurrencyStore.ts',
  };
  const names = Object.keys(FACTORIES);

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', '__mocks__', 'node_modules'].includes(entry.name)) productionFiles(full, out);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
        && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('calls createModelPricing and createAccountCurrencyStore once each, at the top level of their shells', () => {
    const calls: Record<string, string[]> = Object.fromEntries(names.map(name => [name, []]));
    const strays: string[] = [];
    for (const file of productionFiles(desktopSrc)) {
      const text = read(file);
      if (!names.some(name => text.includes(name))) continue;
      const rel = path.relative(desktopSrc, file).split(path.sep).join('/');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
        /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node, inFunction: boolean) => {
        if (ts.isIdentifier(node) && names.includes(node.text)) {
          const parent = node.parent;
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          if ((ts.isCallExpression(parent) && parent.expression === node)
            || (ts.isPropertyAccessExpression(parent) && parent.name === node
              && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) {
            calls[node.text].push(inFunction ? `${rel}:${line} (inside a function)` : rel);
          } else if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
            && (parent.propertyName === undefined || parent.propertyName.text === parent.name.text)) {
            // An unrenamed import or re-export: calls through it are counted above.
          } else if (!(ts.isFunctionDeclaration(parent) && parent.name === node) && !ts.isTypeQueryNode(parent)) {
            strays.push(`${rel}:${line} ${parent.getText(source).split('\n')[0]}`);
          }
        }
        ts.forEachChild(node, child => visit(child, inFunction || ts.isFunctionLike(node)));
      };
      visit(source, false);
    }
    expect(strays, 'a factory renamed or passed on as a value').toEqual([]);
    for (const name of names) expect(calls[name], name).toEqual([FACTORIES[name]]);
  });
});

describe('Host macOS system proxy rules', () => {
  // 规则：Host 读 macOS 系统代理时照的是某一版 Electron 里 Chromium 的规则（apps/host/src/macos-system-proxy.ts，
  // 放行表第 28 行 28b），常量 CHROMIUM_RULES_ELECTRON_VERSION 写明是哪一版。桌面升级 Electron 时这条变红；
  // 升级的人改这个常量就会改到实现文件，macOS 比对（.github/workflows/macos-system-proxy-compare.yml）随之在
  // 那个 PR 上运行。失效后果：Chromium 的代理规则变了（例如新增的隐式例外），Host 与桌面悄悄分叉。
  it('follows the Electron version the desktop ships', () => {
    const rules = read(path.join(hostSrc, 'macos-system-proxy.ts'));
    const declared = /^export const CHROMIUM_RULES_ELECTRON_VERSION = '([^']+)';$/m.exec(rules)?.[1];
    assert.ok(declared, 'CHROMIUM_RULES_ELECTRON_VERSION is declared in apps/host/src/macos-system-proxy.ts');
    const desktop = JSON.parse(read(path.join(repo, 'apps/desktop/package.json')));
    const electron = desktop.devDependencies?.electron ?? desktop.dependencies?.electron;
    assert.equal(declared, electron,
      `apps/desktop/package.json 的 Electron 是 ${electron}，apps/host/src/macos-system-proxy.ts 的 `
      + `CHROMIUM_RULES_ELECTRON_VERSION 是 ${declared}：改这个常量，并等 macOS 系统代理比对 `
      + '(.github/workflows/macos-system-proxy-compare.yml) 在这个 PR 上通过');
  });
});

let hostImportGraphResult: Promise<string[]> | undefined;

/**
 * The modules the Host bundles (apps/host/scripts/build.mjs entries) and the acceptance scripts load, built
 * once and shared by the guards below that classify what the Host loads.
 */
function hostImportGraph(): Promise<string[]> {
  return hostImportGraphResult ??= (async () => {
    const scripts = fs.readdirSync(path.join(repo, 'apps/host/scripts')).filter(name => name.endsWith('.e2e.mjs')).sort()
      .map(name => `apps/host/scripts/${name}`);
    const result = await build({
      absWorkingDir: repo, bundle: true, write: false, metafile: true, splitting: true, platform: 'node', format: 'esm',
      target: 'node22', outdir: path.join(os.tmpdir(), 'cindy-host-graph-unused'), logLevel: 'silent',
      entryPoints: ['apps/host/src/main.ts', 'apps/host/src/plugins/node-worker.ts', 'apps/host/src/agent/pi-subagent-runner-process.cts',
        'apps/desktop/src/main/cindy-brain/libraryDbWorker.ts', 'apps/desktop/src/main/cindy-brain/ghostSnapshotWorkerProcess.ts', ...scripts],
      plugins: [{ name: 'host-graph', setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, () => ({ path: 'raw', namespace: 'raw' }));
        builder.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: '', loader: 'text' }));
        builder.onResolve({ filter: /^[^./]/ }, args => (isBuiltin(args.path)
          || !(args.path.startsWith('@cindy/') || /^cindy-tools(\/|$)/.test(args.path) || args.path.startsWith('#'))
          ? { path: args.path, external: true } : undefined));
      } }],
    });
    return Object.keys(result.metafile.inputs).filter(file => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file));
  })();
}

/**
 * Rule: a shared module may keep a port in a module variable that the desktop fills once at startup
 * (setX(impl)). Unlike a factory port it fails nothing when unbound: the module falls back to null, a
 * no-op, an empty table or a refusal, so a port the Host never binds goes unnoticed (甲 5 found
 * claude-transcript-relocation.ts's liveCcSessionBridge only by reading the code). Every such setter in
 * the modules the Host loads is classified in apps/host/src/desktop-module-setters.ts.
 * Collection: the Host's static import graph from the entries of apps/host/scripts/build.mjs plus the
 * acceptance scripts, resolved by esbuild without running any module (workspace packages followed,
 * third-party packages external). In its desktop and package sources (generated and vendored code
 * excluded): exported functions named set|register|bind|configure|install|init… that write a
 * module-level slot, and exported empty containers that another file in the graph mutates.
 * A slot is any module-level binding, whatever it starts as: a let/var may be reassigned, and any binding (const
 * too) may have its contents replaced. The initial value is not looked at: a plain `let enabled = false` is as
 * much a port the Host can leave at its default as a `let reader = null` (active-catalog.ts
 * openAiImagesApiKeyConfigured). Destructured declarations (`let [a, b] = …`) count by each name. Wrapped
 * forms (`as`, `satisfies`, `!`, `<T>`, parentheses) are unwrapped.
 * Imported values (default, named, namespace; not types) are const bindings of the importing module.
 * A write is any assignment operator (`=`, `+=`, `|=`, `<<=`, `??=`, …) or `++` / `--` on a let/var, the same on a
 * property of any binding (logger.ts
 * `mainSlot.dir = …`), a container mutation (`.set`, `.push`, …) or `Object.assign(binding, …)` (projectAutomaticIcon.ts),
 * anywhere in the setter including its callbacks, or in a module function it calls, followed transitively
 * (active-catalog.ts setters through markChanged, codex-process-registry.ts registerCodexProcessRole through
 * registerAgentProcess); a result reached by skipping a function already on the call path (mutual recursion) is
 * not remembered, so a setter that enters the cycle elsewhere is judged afresh. This reaches some setters that are
 * not ports in practice (read_sheet.ts: the tool's worker pool); the table records them as internal with why.
 * Failure: a new setter (or a newly loaded module with one) that the table does not classify, or a table
 * entry whose setter is gone, turns this red until the table is updated. A `bound` entry must bind it in
 * the Host file it names (bindsIn: a call, a container mutation, or the setter handed over as a value);
 * `where: '<file>#<function>'` narrows that to one function of the file, for a file that binds the same
 * setter more than once (skill-projection-owner.ts: serve refuses, `cindy-host login` allows) or binds it from a
 * startup function (project-icon.ts bindHostProjectIconRuntime); such a function must be called by another Host
 * file the Host loads (main.ts), so dropping that call fails too.
 * Not seen, by form:
 * - slots declared other than at module level (inside a block, an IIFE, a namespace or a class body,
 *   static fields included);
 * - writes through destructuring assignment (`({ a: slot } = x)`), through an alias (`const s = state; s.x = …`),
 *   through a function the module imports from another file, or through Reflect/defineProperty;
 * - state on globalThis or process, or reached through createRequire or a dynamic import at run time;
 * - setters not exported as a function: a method of an exported object or class, a default export,
 *   a setter not named this way;
 * - closure state of factories;
 * and, for a setter handed over as a port value, whether the receiving code really calls it; for
 * `<file>#<function>`, whether the caller found is itself reached at run time (one call level is checked).
 */
describe('Host Chromium proxy helper (row 28, 28c)', () => {
  const worker = () => read(path.join(hostSrc, 'chromium-proxy-worker.cjs'));
  const launcher = () => read(path.join(hostSrc, 'chromium-proxy.ts'));
  const TEST_SWITCHES = ['use-mock-keychain', 'proxy-pac-url', 'no-proxy-server', 'proxy-server', 'CINDY_PROXY_WORKER_TEST_CONFIG'];

  // 规则：生产启动不带任何测试开关（审核方 2026-11-18）：Host 只以 `[脚本]` 起辅助进程，环境经 helperEnv 筛选系统目录和
  // 语言变量后只加 profile 目录；测试配置与 Chromium 开关只出现在辅助进程脚本（读测试配置）和验收脚本里。
  // 失效后果：生产里的辅助进程用了 mock 钥匙串或固定代理配置，与系统设置不一致，或测试配置经环境漏进生产。
  it('starts the helper the production way: no switch, no test configuration', () => {
    const source = launcher();
    assert.equal(source.split('spawnImpl(').length - 1, 1);
    assert.ok(source.includes('child = spawnImpl(found.binary, [found.script], {\n        env: helperEnv(profile), stdio:'));
    assert.ok(source.includes("if (SYSTEM_ENV.has(key.toUpperCase())) env[key] = value;"));
    const production = fs.readdirSync(hostSrc, { recursive: true }).map(String)
      .filter(file => /\.(ts|mts|cts|mjs|cjs|js)$/.test(file) && !/\.test\.|[\\/]loaders[\\/]/.test(file) && file !== 'chromium-proxy-worker.cjs')
      .map(file => path.join(hostSrc, file));
    for (const file of [...production, path.join(repo, 'apps/host/scripts/build.mjs')]) {
      const text = read(file);
      for (const name of TEST_SWITCHES) assert.equal(text.includes(name), false, `${path.relative(repo, file)} mentions ${name}`);
    }
    assert.equal(worker().split('process.env.CINDY_PROXY_WORKER_TEST_CONFIG').length - 1, 1);
  });

  // 规则：辅助进程只用不落盘的内存分区，不碰 defaultSession、safeStorage、单实例锁、窗口或端口；先应用配置、强制重载、
  // 解析一次再报 ready，ready 之前一律回 not_ready（审核方 2026-11-18）。失效后果：写 cookie 或触发 Safe Storage
  // 钥匙串条目；开了端口或窗口；PAC 未就绪时回 DIRECT。
  it('the helper asks an in-memory session and keeps off the keychain, windows and ports', () => {
    const source = worker();
    assert.ok(source.includes("  const candidate = session.fromPartition('cindy-proxy-helper', { cache: false });\n"));
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['persist:', 'defaultSession', 'safeStorage', 'requestSingleInstanceLock', 'BrowserWindow', 'loadURL',
      'createServer', "require('node:http')", "require('node:net')", 'appendSwitch']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.ok(source.includes('app.disableHardwareAcceleration();\n'));
    assert.ok(source.includes("app.setPath('userData', profile);\n"));
    assert.ok(source.includes("lines.on('close', () => app.quit());\n"));
    assert.ok(source.includes("  if (!ses) return send({ id: request.id, error: 'not_ready' });\n"));
    const ready = between(source, '  await candidate.setProxy(', "  send({ ready: true, pid: process.pid });");
    assert.deepEqual(ready.split('\n').filter(line => !line.startsWith('//')), [
      "await candidate.setProxy(testConfig ? JSON.parse(testConfig) : { mode: 'system' });",
      'await candidate.forceReloadProxyConfig();',
      'await candidate.resolveProxy(READINESS_PROBE);',
      'ses = candidate;',
    ]);
  });

  // 规则：Host 包里的 Electron 是 npm 原版（build.mjs 从 desktopRequire('electron') 拷贝），apps/host 里没有翻 fuse 的代码
  // （flipFuses；验收脚本只读 fuse），cookie 加密默认关闭；装了二进制时直接读它的 fuse（CI 的桌面任务不下载二进制，那里只核对源码；macOS/Windows 的比对
  // workflow 在验收脚本里读同一个 fuse）。失效后果：换成翻过 fuse 的 Electron 后，辅助进程启动即触发钥匙串。
  it('ships the npm Electron, with cookie encryption off', async () => {
    const build = read(path.join(repo, 'apps/host/scripts/build.mjs'));
    assert.ok(build.includes("    const executable = desktopRequire('electron');\n"));
    assert.ok(build.includes("    await fs.copyFile(path.join(host, 'src/chromium-proxy-worker.cjs'), path.join(bin, 'chromium-proxy-worker.cjs'));\n"));
    const hostFiles = fs.readdirSync(path.join(repo, 'apps/host'), { recursive: true }).map(String)
      .filter(file => !file.includes('node_modules') && /\.(ts|mts|cts|mjs|cjs|js|json)$/.test(file));
    for (const file of hostFiles) assert.equal(read(path.join(repo, 'apps/host', file)).includes('flipFuses'), false, file);
    let executable: string | null = null;
    try { executable = createRequire(path.join(repo, 'apps/desktop/package.json'))('electron') as string; } catch { executable = null; }
    if (!executable || !fs.existsSync(executable)) return;
    const fuses = await import('@electron/fuses');
    const wire = await fuses.getCurrentFuseWire(process.platform === 'darwin' ? path.resolve(executable, '../../..') : executable);
    expect(String.fromCharCode(wire[fuses.FuseV1Options.EnableCookieEncryption] as number), 'EnableCookieEncryption').toBe('0');
  });
});

/**
 * Rule: every module the Host loads that opens network connections itself is classified in
 * apps/host/src/host-network-modules.ts: whether its traffic to other machines takes the outbound proxy resolver
 * (release table row 28). Collection over the Host's import graph (as for the setters below): a value import of
 * node:http, https, net, tls, http2, dgram, undici or ws (import, require or dynamic import), a reference to the
 * global fetch, a direct fetch call, or `new WebSocket(…)`. Counts also catch additional calls through an
 * existing network import, fetch or WebSocket constructor in an already classified file. Failure without it: a new
 * outbound call that bypasses the resolver (direct in a network that needs a proxy) lands unnoticed.
 */
describe('network modules the Host loads, classified for the Host', () => {
  const NETWORK = new Set(['http', 'https', 'net', 'tls', 'http2', 'dgram', 'undici', 'ws']);
  const bare = (name: string) => name.replace(/^node:/, '');

  function networkUses(file: string, text: string): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const uses = new Set<string>();
    let declaresFetch = false;
    let fetchReferences = 0;
    let qualifiedFetches = 0;
    let socketConstructors = 0;
    let fetchCalls = 0;
    let networkCalls = 0;
    const importedNames = new Set<string>();
    const declares = (n: ts.Node): n is ts.ParameterDeclaration | ts.VariableDeclaration | ts.BindingElement | ts.FunctionDeclaration =>
      ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n);
    const visit = (n: ts.Node): void => {
      if (ts.isTypeNode(n)) return;
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && NETWORK.has(bare(n.moduleSpecifier.text))) {
        const clause = n.importClause;
        const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(element => element.isTypeOnly)));
        if (!typeOnly) {
          uses.add(`imports ${bare(n.moduleSpecifier.text)}`);
          if (clause?.name) importedNames.add(clause.name.text);
          if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) importedNames.add(clause.namedBindings.name.text);
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) importedNames.add(element.name.text);
          }
        }
      }
      if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && NETWORK.has(bare(n.arguments[0].text))
        && ((ts.isIdentifier(n.expression) && n.expression.text === 'require') || n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        uses.add(`imports ${bare(n.arguments[0].text)}`);
      }
      if (declares(n) && n.name && ts.isIdentifier(n.name) && n.name.text === 'fetch') declaresFetch = true;
      if (ts.isIdentifier(n) && n.text === 'fetch') {
        const p = n.parent;
        const name = (ts.isPropertyAccessExpression(p) && p.name === n)
          || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p)
            || ts.isPropertyDeclaration(p)) && p.name === n)
          || ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || (declares(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n);
        if (!name) fetchReferences++;
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'fetch' && ts.isIdentifier(n.expression)
        && ['globalThis', 'global'].includes(n.expression.text)) qualifiedFetches++;
      if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === 'fetch'
        && ts.isIdentifier(n.expression) && ['globalThis', 'global'].includes(n.expression.text)) qualifiedFetches++;
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'WebSocket') socketConstructors++;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') fetchCalls++;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        let base: ts.Expression = n.expression;
        while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base) && importedNames.has(base.text)) networkCalls++;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const fetchUses = qualifiedFetches + (declaresFetch ? fetchCalls : fetchReferences);
    if (fetchUses) uses.add(`fetch ×${fetchUses}`);
    if (socketConstructors) uses.add(`new WebSocket ×${socketConstructors}`);
    if (networkCalls) uses.add(`network API calls ×${networkCalls}`);
    return [...uses].sort();
  }

  it('classifies every network module the Host loads, with exactly what it uses', async () => {
    const { HOST_NETWORK_MODULES } = await import(pathToFileURL(path.join(hostSrc, 'host-network-modules.ts')).href) as
      { HOST_NETWORK_MODULES: Record<string, { uses: readonly string[]; route: string; reason: string }> };
    const found = new Map<string, string[]>();
    for (const file of await hostImportGraph()) {
      if (/^apps\/host\/scripts\//.test(file)) continue;
      const uses = networkUses(file, read(path.join(repo, file)));
      if (uses.length) found.set(file, uses);
    }
    const table = new Map(Object.entries(HOST_NETWORK_MODULES).map(([file, row]) => [file, [...row.uses].sort()]));
    expect([...found.keys()].filter(file => !table.has(file)).sort(), 'network modules missing from apps/host/src/host-network-modules.ts').toEqual([]);
    expect([...table.keys()].filter(file => !found.has(file)).sort(), 'entries whose module opens no connection any more').toEqual([]);
    for (const [file, uses] of found) expect(table.get(file), file).toEqual(uses);
    const keys = Object.keys(HOST_NETWORK_MODULES);
    expect(keys, 'sorted').toEqual([...keys].sort());
    for (const [file, row] of Object.entries(HOST_NETWORK_MODULES)) {
      expect(['resolver', 'injected', 'loopback', 'no-connection', 'same-as-desktop'], file).toContain(row.route);
      expect(row.reason.length, file).toBeGreaterThan(10);
    }
  }, 60_000);
});

describe('module-level port setters the Host loads, classified for the Host', () => {
  const tableFile = path.join(hostSrc, 'desktop-module-setters.ts');
  const SETTER = /^(set|register|bind|configure|install|init)[A-Z]/;
  const MUTATORS = new Set(['set', 'push', 'add', 'unshift', 'splice', 'delete', 'clear']);
  type Entry = { status: string; where?: string; reason?: string };

  function settersIn(file: string): { setters: string[]; containers: string[] } {
    const sf = ts.createSourceFile(file, read(path.join(repo, file)), ts.ScriptTarget.Latest, true);
    const exported = new Set<string>();
    for (const statement of sf.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text);
    }
    const isExported = (node: ts.Statement) => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    // Every module-level binding, whatever it starts as (null, a function, an import, a plain `false`): the desktop
    // may replace a let/var, or the contents of any binding, and the Host may not. true = can be reassigned.
    const slots = new Map<string, boolean>();
    const functions: Array<{ name: string; node: ts.Node }> = [];
    const containers: string[] = [];
    const unwrap = (n: ts.Expression | undefined): ts.Expression | undefined => {
      while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)
        || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression;
      return n;
    };
    // Imported values are const bindings of this module too: `import { state } from './x'` then `state.y = v`.
    for (const statement of sf.statements) {
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) slots.set(clause.name.text, false);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) slots.set(named.name.text, false);
      if (named && ts.isNamedImports(named)) for (const element of named.elements) if (!element.isTypeOnly) slots.set(element.name.text, false);
    }
    const bindingNames = (name: ts.BindingName): string[] => (ts.isIdentifier(name) ? [name.text]
      : name.elements.flatMap(element => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name))));
    for (const statement of sf.statements) {
      if (ts.isVariableStatement(statement)) {
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of statement.declarationList.declarations) {
          const init = unwrap(declaration.initializer);
          if (ts.isIdentifier(declaration.name)) {
            const name = declaration.name.text;
            const isFunction = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
            if (isFunction && (isExported(statement) || exported.has(name))) {
              functions.push({ name, node: init! });
              continue;
            }
            const emptyContainer = !!init && ((ts.isNewExpression(init) && ts.isIdentifier(init.expression)
              && /^(Map|Set|WeakMap|WeakSet)$/.test(init.expression.text) && !init.arguments?.length)
              || (ts.isArrayLiteralExpression(init) && init.elements.length === 0));
            if (isExported(statement) && isConst && emptyContainer) containers.push(name);
          }
          for (const name of bindingNames(declaration.name)) slots.set(name, !isConst);
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name && (isExported(statement) || exported.has(statement.name.text))) {
        functions.push({ name: statement.name.text, node: statement });
      }
    }
    // Every assignment operator TypeScript has (`=` through `??=`: `+=`, `|=`, `<<=`, …), as numbers and bit flags are slots too.
    const isAssignment = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
    /** `slot = …` for a let/var; `slot.x = …` or `slot[k] = …` for any binding. */
    const isSlotTarget = (raw: ts.Expression | undefined): boolean => {
      const n = unwrap(raw);
      if (!n) return false;
      if (ts.isIdentifier(n)) return slots.get(n.text) === true;
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const target = unwrap(n.expression);
        return !!target && ts.isIdentifier(target) && slots.has(target.text);
      }
      return false;
    };
    const moduleFunctions = new Map<string, ts.Node>();
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) moduleFunctions.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        const init = unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
          moduleFunctions.set(declaration.name.text, init);
      }
    }
    /** Writes in a function body: assignment (`=`, `??=`, `||=`, `&&=`), a container mutation or `Object.assign(slot, …)`
     * on a module binding, anywhere in the body including callbacks; or a call to a module function that writes (a
     * private `apply(impl)` helper), followed transitively. A result reached while skipping a function already on the
     * path (mutual recursion) is partial: it is passed up but not remembered, so a later setter that enters the cycle
     * elsewhere is judged afresh. */
    const writesMemo = new Map<string, boolean>();
    const writesSlot = (node: ts.Node, path: Set<string>): { writes: boolean; partial: boolean } => {
      let writes = false;
      let partial = false;
      const visit = (n: ts.Node): void => {
        if (writes) return;
        if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind) && isSlotTarget(n.left)) writes = true;
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
          && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && isSlotTarget(n.operand)) writes = true;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const callee = n.expression;
          if (ts.isIdentifier(callee.expression) && MUTATORS.has(callee.name.text) && slots.has(callee.expression.text)) writes = true;
          if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' && callee.name.text === 'assign') {
            const target = unwrap(n.arguments[0]);
            if (target && ts.isIdentifier(target) && slots.has(target.text)) writes = true;
          }
        }
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && moduleFunctions.has(n.expression.text)) {
          const helper = n.expression.text;
          if (path.has(helper)) partial = true;
          else if (writesMemo.has(helper)) writes ||= writesMemo.get(helper)!;
          else {
            const result = writesSlot(moduleFunctions.get(helper)!, new Set([...path, helper]));
            if (result.writes || !result.partial) writesMemo.set(helper, result.writes);
            else partial = true;
            writes ||= result.writes;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return { writes, partial };
    };
    const setters = functions
      .filter(({ name, node }) => SETTER.test(name) && !/ForTest|ForTesting|^__/.test(name) && writesSlot(node, new Set([name])).writes)
      .map(({ name }) => name);
    return { setters, containers };
  }

  /** Whether a Host file binds `name`: calls it (`name(…)`, `x.name(…)`), mutates the container
   * (`name.set(…)`, …), or hands it over as a port value (a call argument or an object property).
   * A call that only passes null or undefined (the teardown `setX(null)`) does not bind. With `inFunction`,
   * only that function of the file (a declaration or a const initialised to a function) counts. */
  function bindsIn(file: string, name: string, inFunction?: string): boolean {
    const source = ts.createSourceFile(file, read(path.join(repo, file)), ts.ScriptTarget.Latest, true);
    const named = (n: ts.Node): ts.Node | undefined =>
      (ts.isFunctionDeclaration(n) && n.name?.text === inFunction)
      || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === inFunction && n.initializer)
        ? n : ts.forEachChild(n, named);
    const sf = inFunction ? named(source) : source;
    if (!sf) return false;
    const isName = (n: ts.Node) => (ts.isIdentifier(n) && n.text === name) || (ts.isPropertyAccessExpression(n) && n.name.text === name);
    const isNullish = (n: ts.Node) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined');
    let binds = false;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ((isName(n.expression) && !(n.arguments.length > 0 && n.arguments.every(isNullish))) || n.arguments.some(isName)
        || (ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text) && isName(n.expression.expression)))) binds = true;
      if ((ts.isShorthandPropertyAssignment(n) && n.name.text === name) || (ts.isPropertyAssignment(n) && isName(n.initializer))) binds = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return binds;
  }

  /** The table as written: key, entry, and whether the entry sits on one line. */
  function table(): Array<{ key: string; entry: Entry; oneLine: boolean }> {
    const sf = ts.createSourceFile(tableFile, read(tableFile), ts.ScriptTarget.Latest, true);
    let literal: ts.ObjectLiteralExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'DESKTOP_MODULE_SETTERS'
        && n.initializer && ts.isObjectLiteralExpression(n.initializer)) literal = n.initializer;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.ok(literal, 'DESKTOP_MODULE_SETTERS not found');
    const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
    return literal.properties.map(property => {
      assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isObjectLiteralExpression(property.initializer),
        `unexpected entry ${property.getText(sf)}`);
      const entry: Entry = { status: '' };
      for (const field of property.initializer.properties) {
        assert.ok(ts.isPropertyAssignment(field) && ts.isIdentifier(field.name) && ts.isStringLiteral(field.initializer));
        (entry as Record<string, string>)[field.name.text] = field.initializer.text;
      }
      return { key: property.name.text, entry, oneLine: line(property.getStart(sf)) === line(property.getEnd()) };
    });
  }

  it('classifies every setter the Host loads, and only those', async () => {
    const graph = await hostImportGraph();
    const texts = new Map(graph.map(file => [file, read(path.join(repo, file))]));
    const collected = new Set<string>();
    for (const file of graph) {
      if (!/^(apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file) || /\/(_generated|vendor)\//.test(file)) continue;
      const { setters, containers } = settersIn(file);
      for (const name of setters) collected.add(`${file}#${name}`);
      for (const name of containers) {
        const mutation = new RegExp(`\\b${name}\\.(set|add|delete|clear|push|splice|unshift)\\(`);
        if ([...texts].some(([other, text]) => other !== file && mutation.test(text))) collected.add(`${file}#${name}`);
      }
    }
    const rows = table();
    const keys = rows.map(row => row.key);
    expect([...collected].filter(key => !keys.includes(key)).sort(), 'setters missing from desktop-module-setters.ts').toEqual([]);
    expect(keys.filter(key => !collected.has(key)), 'entries whose setter is gone').toEqual([]);
  }, 60_000);

  /** Host files the Host loads, other than `file`, that call `fn` (`fn(…)` or `x.fn(…)`). */
  async function hostCallersOf(file: string, fn: string): Promise<string[]> {
    const callers: string[] = [];
    for (const other of await hostImportGraph()) {
      if (other === file || !/^apps\/host\/src\//.test(other)) continue;
      const text = read(path.join(repo, other));
      if (!text.includes(fn)) continue;
      const sf = ts.createSourceFile(other, text, ts.ScriptTarget.Latest, true);
      let calls = false;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && n.expression.text === fn)
          || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === fn))) calls = true;
        if (!calls) ts.forEachChild(n, visit);
      };
      visit(sf);
      if (calls) callers.push(other);
    }
    return callers;
  }

  it('keeps the table sorted, one entry per line, each status with its evidence', async () => {
    const rows = table();
    const keys = rows.map(row => row.key);
    expect(keys).toEqual([...keys].sort());
    expect(rows.filter(row => !row.oneLine).map(row => row.key)).toEqual([]);
    for (const { key, entry } of rows) {
      expect(['bound', 'pending', 'not-applicable', 'internal'], key).toContain(entry.status);
      // No entry waits on an id or a row nobody has given it yet.
      expect(entry.reason ?? '', key).not.toMatch(/\bto be (assigned|decided|added)\b/i);
      if (entry.status === 'bound') {
        // The Host file named must really bind it: a mention in a comment, string, type or import does not count.
        expect(entry.where, key).toMatch(/^apps\/host\//);
        const [whereFile, whereFunction] = entry.where!.split('#');
        expect(bindsIn(whereFile, key.split('#')[1], whereFunction), `${key} not bound in ${entry.where}`).toBe(true);
        // A binding inside a function binds only if the Host calls it (main.ts bindHostProjectIconRuntime()).
        if (whereFunction) expect((await hostCallersOf(whereFile, whereFunction)).length, `${entry.where} is never called`).toBeGreaterThan(0);
      } else {
        expect(entry.reason?.trim(), key).toBeTruthy();
        // Release table file lines drift with every edit; point at row ids, 甲/乙 gaps or section names.
        expect(entry.reason, key).not.toMatch(/release table[^)]*\bline\s*\d/);
        // Source line numbers drift too: name the file (and function), not `file.ts:12`.
        expect(entry.reason, key).not.toMatch(/\.(ts|tsx|mts|cts|js|mjs|cjs):\d/);
        if (entry.status === 'pending') expect(entry.reason, key).toMatch(/\brow \w+|[甲乙]/);
      }
    }
  }, 60_000);
});

/**
 * Rule: the build region is fixed per Host release (release table 甲 20, region-and-editions.md §2.4):
 * scripts/build.mjs bakes --region into shared/brandRegion.ts, loaders/raw-hook.mjs follows
 * CINDY_HOST_REGION from source. A desktop module that reads it therefore behaves as the Host's edition,
 * not as the desktop build it was written for; each one the Host loads is judged and listed in
 * apps/host/src/desktop-region-readers.ts.
 * Collection: the Host's import graph of the setter guard above (hostImportGraph); in its desktop and
 * package sources (generated and vendored code excluded), imports and re-exports of CURRENT_CINDY_REGION
 * or CURRENT_APP_ID from shared/brandRegion, and direct reads of VITE_CINDY_AUTH_REGION or
 * CINDY_AUTH_REGION on import.meta.env or process.env (comments and strings do not count); in the Host's
 * own sources, region fallbacks `x === 'cn' ? 'cn' : 'global'` (either way round), keyed by the enclosing
 * function: they fall to a fixed region rather than the release's, and are listed with why they cannot be
 * reached (startDeviceLink and disableShareAvailability: only after sign-in sets the realm).
 * Failure: a module that starts reading the region, or a reader that comes into the graph (the desktop
 * inventory's 40 files outside it today), fails until the table says how it behaves on the Host; an entry
 * whose file no longer reads fails too, so a fallback that moves to another function is judged again.
 * Not seen: values derived from the region and exported under other names (regionalMoney.ts's
 * DEFAULT_USAGE_CURRENCY, legalLinks.ts's LEGAL_LINKS): their modules are the listed readers.
 */
describe('desktop modules the Host loads that read the build region, classified for the Host', () => {
  const tableFile = path.join(hostSrc, 'desktop-region-readers.ts');
  const REGION_CONSTANTS = new Set(['CURRENT_CINDY_REGION', 'CURRENT_APP_ID']);
  const REGION_ENV = /^(VITE_)?CINDY_AUTH_REGION$/;

  /** The Host's own `x === 'cn' ? 'cn' : 'global'` fallbacks, by enclosing function. */
  function fallbacksIn(file: string): string[] {
    const sf = ts.createSourceFile(file, read(path.join(repo, file)), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const isRegion = (n: ts.Expression) => ts.isStringLiteralLike(n) && (n.text === 'cn' || n.text === 'global');
    const enclosing = (n: ts.Node): string => {
      for (let at: ts.Node | undefined = n.parent; at; at = at.parent) {
        if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText(sf);
        if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at.parent.name.getText(sf);
      }
      return '<module>';
    };
    const visit = (n: ts.Node): void => {
      if (ts.isConditionalExpression(n) && isRegion(n.whenTrue) && isRegion(n.whenFalse)
        && (n.whenTrue as ts.StringLiteralLike).text !== (n.whenFalse as ts.StringLiteralLike).text
        && ts.isBinaryExpression(n.condition) && n.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && isRegion(n.condition.right) && (n.condition.right as ts.StringLiteralLike).text === (n.whenTrue as ts.StringLiteralLike).text) {
        found.add(`${enclosing(n)}:realm-fallback`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...found];
  }

  function readsIn(file: string): string[] {
    const sf = ts.createSourceFile(file, read(path.join(repo, file)), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const isEnv = (n: ts.Expression) => /^(import\.meta\.env|process\.env)$/.test(n.getText(sf).replace(/\?/g, ''));
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
        && /(^|\/)brandRegion(\.(js|ts))?$/.test(n.moduleSpecifier.text)) {
        const named = ts.isImportDeclaration(n) ? n.importClause?.namedBindings : n.exportClause;
        if (named && ts.isNamespaceImport(named)) found.add('*');
        if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
          for (const element of named.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (REGION_CONSTANTS.has(name)) found.add(name);
          }
        }
        if (ts.isExportDeclaration(n) && !n.exportClause) found.add('*');
      }
      if (ts.isPropertyAccessExpression(n) && REGION_ENV.test(n.name.text) && isEnv(n.expression)) found.add('env');
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
        && REGION_ENV.test(n.argumentExpression.text) && isEnv(n.expression)) found.add('env');
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...found];
  }

  /** The table as written: key, its `host` note, and whether the entry sits on one line. */
  function table(): Array<{ key: string; host: string; oneLine: boolean }> {
    const sf = ts.createSourceFile(tableFile, read(tableFile), ts.ScriptTarget.Latest, true);
    let literal: ts.ObjectLiteralExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'DESKTOP_REGION_READERS'
        && n.initializer && ts.isObjectLiteralExpression(n.initializer)) literal = n.initializer;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.ok(literal, 'DESKTOP_REGION_READERS not found');
    const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
    return literal.properties.map(property => {
      assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isObjectLiteralExpression(property.initializer),
        `unexpected entry ${property.getText(sf)}`);
      let host = '';
      for (const field of property.initializer.properties) {
        assert.ok(ts.isPropertyAssignment(field) && ts.isIdentifier(field.name) && field.name.text === 'host'
          && ts.isStringLiteral(field.initializer), `unexpected field in ${property.name.text}`);
        host = field.initializer.text;
      }
      return { key: property.name.text, host, oneLine: line(property.getStart(sf)) === line(property.getEnd()) };
    });
  }

  it('lists every region reader the Host loads, and only those', async () => {
    const collected = new Set<string>();
    for (const file of await hostImportGraph()) {
      // Parse only files that can match: each rule needs one of these words in the text.
      const text = read(path.join(repo, file));
      if (/^apps\/host\/src\//.test(file) && /['"`]cn['"`]/.test(text)) for (const what of fallbacksIn(file)) collected.add(`${file}#${what}`);
      if (!/^(apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file) || /\/(_generated|vendor)\//.test(file)) continue;
      if (/brandRegion|CINDY_AUTH_REGION/.test(text)) for (const what of readsIn(file)) collected.add(`${file}#${what}`);
    }
    const keys = table().map(row => row.key);
    expect([...collected].filter(key => !keys.includes(key)).sort(), 'region readers missing from desktop-region-readers.ts').toEqual([]);
    expect(keys.filter(key => !collected.has(key)), 'entries that no longer read the region').toEqual([]);
  }, 60_000);

  it('keeps the table sorted, one entry per line, each with how it behaves on the Host', () => {
    const rows = table();
    const keys = rows.map(row => row.key);
    expect(keys).toEqual([...keys].sort());
    expect(rows.filter(row => !row.oneLine).map(row => row.key)).toEqual([]);
    expect(rows.filter(row => !row.host.trim()).map(row => row.key)).toEqual([]);
    for (const { key, host } of rows) {
      // As the setter table: name the file and function, not `file.ts:12`, and wait on nothing unnamed.
      expect(host, key).not.toMatch(/\.(ts|tsx|mts|cts|js|mjs|cjs):\d/);
      expect(host, key).not.toMatch(/\bto be (assigned|decided|added)\b/i);
    }
  });
});
