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
import { describe, it } from 'vitest';

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
    const hostModels = between(runtime, 'resolvePiRuntimeModels: () =>', '...(claudeProxy ? { registerPiProxySession', true);
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
});
