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
import fs from 'node:fs';
import path from 'node:path';
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
  // MCP 注册协议：platformTools 已并入 hostTools，最终交给引擎时不能再次展开。
  // Bug：main 合并冲突会重复注册同名服务；main 顶层会启动 Host，故在 guard 层保护组装边界。
  it('registers platform providers once through the shared Host tools list', () => {
    const main = read(path.join(hostSrc, 'main.ts'));
    assert.equal(main.split('hostTools.providers.push(...platformTools.providers);').length - 1, 1);
    const registration = call(main, 'pluginGateway.prepareMcpProviders(');
    assert.equal(registration.split('...hostTools.providers').length - 1, 1);
    assert.equal(registration.includes('platformTools.providers'), false);
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
    assert.ok(main.includes("import { startHostSystemProxySettings } from './outbound-proxy.ts';\n"));
    assert.equal(main.split('startHostSystemProxySettings();').length - 1, 1);
    const call = main.indexOf('\nstartHostSystemProxySettings();\n');
    assert.ok(call > 0 && call < main.indexOf('\nconst command = process.argv[2];\n'), 'a top-level call before the command dispatch');
    const outbound = read(path.join(hostSrc, 'outbound-proxy.ts'));
    assert.ok(outbound.includes("  if (process.platform === 'darwin') useHostSystemProxySettings(readScutilProxyOutput);\n"));
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
      host: 'turn-executor.mjs finish: error row, Codex plan failure, change record partial, Git abort; context recovery claim',
      gaps: ['A15 Opus plan error reason', 'checkpoint 4 (terminal to the coordinator first, auto-resume)'],
    },
    image: { gaps: ['A11 Codex generated images'] },
    interaction_dismissed: { gaps: ['A12 runtime interaction_dismissed'] },
    plan_mode_changed: { host: 'turn-executor.mjs persistAgentPlanModeChange (shared persistAgentPlanModeChangeWith)' },
    status: {
      host: 'turn-executor.mjs context snapshot (shared), background activity',
      gaps: ['smaller difference: running=false alone does not write the turn end time'],
    },
    text: { host: 'history.event (sessionEventStreamCore, shared)', gaps: ['A14 standaloneText notices'] },
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
    for (const file of ['sessionEventPreparation.ts', 'sessionEventDelivery.ts', 'sessionEventTerminal.ts']) {
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
