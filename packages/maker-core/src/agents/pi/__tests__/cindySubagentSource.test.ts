import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { PI_SUBAGENT_TOOL_NAME } from '@cindy/maker-shared/agent-task';

import {
  CINDY_SUBAGENT_ENV,
  CINDY_SUBAGENT_EXTENSION_FILENAME,
  CINDY_SUBAGENT_EXTENSION_SOURCE,
  CINDY_SUBAGENT_PARENT_PID_ENV,
  CINDY_SUBAGENT_TOOL_NAME,
} from '../cindy-subagent-source.js';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';
import { CINDY_SUBAGENT_RUNNER_SOURCE } from '../cindy-subagent-runner-source.js';
import { PI_SUBAGENT_PROGRESS_MARKER } from '../subagent-progress.js';

/**
 * 注入源码是字符串常量,typecheck 与 vitest 都进不去,只能靠结构性断言守。这里守的是
 * 「改一处忘另一处就静默失效」的那几条,不是复读实现细节。
 */
describe('cindy-subagent extension source', () => {
  it('parses as a complete generated TypeScript module', () => {
    const result = ts.transpileModule(CINDY_SUBAGENT_EXTENSION_SOURCE, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    const diagnostics = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    ))).toEqual([]);
  });

  it('registers the tool name the card predicate recognises', () => {
    // 工具名与 maker-shared 的判据脱同步 = 子代理卡完全不渲染(且不报错)。
    expect(CINDY_SUBAGENT_TOOL_NAME).toBe(PI_SUBAGENT_TOOL_NAME);
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const TOOL_NAME = '" + PI_SUBAGENT_TOOL_NAME + "'");
  });

  it('uses the same progress marker the host parser checks', () => {
    // 标记不一致 = 进度帧被 parse 当成别的工具的流式结果丢掉。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const MARKER = '" + PI_SUBAGENT_PROGRESS_MARKER + "'");
  });

  it('reads the exact env names the host injects', () => {
    for (const name of Object.values(CINDY_SUBAGENT_ENV)) {
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("'" + name + "'");
    }
  });

  it('keeps durable management scoped to the current runtime owner', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      'const runtimeOwnerId = process.env[OWNER_ID_ENV];',
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      'status.runtimeOwnerId === runtimeOwnerId',
    );
  });

  it('contains no template literals (String.raw would interpolate them at build time)', () => {
    // 模板里出现 ${...} 会被外层 String.raw 当插值吃掉,注入的源码将缺字段且不易发现。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('`');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('${');
  });

  it('keeps the read-only tool allowlist for every agent profile', () => {
    // 白名单一旦放进 bash/edit/write:ask 档下子进程无确认 UI → bridge fail-closed 全拒,
    // 功能表现为「子代理什么都干不了」;放进去还等于绕过审批面扩权。
    const allowlists = [...CINDY_SUBAGENT_EXTENSION_SOURCE.matchAll(/tools: '([^']+)'/g)].map((m) => m[1]);
    expect(allowlists.length).toBeGreaterThanOrEqual(3);
    for (const list of allowlists) {
      expect(list.split(',').sort()).toEqual(['find', 'grep', 'ls', 'read']);
    }
  });

  it('keeps the guards that stop a subagent from becoming a fork bomb or a wedged turn', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_DEPTH = 1');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('if (readDepth() >= MAX_DEPTH) return;');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_TASKS = 8');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_CONCURRENCY = 4');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_TASK_CHARS = 32000');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_MODEL_CHARS = 500');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toMatch(/TASK_TIMEOUT_MS\s*=/);
    // Durable runner owns a private PI session directory so queued children can
    // resume after the parent turn exits without polluting the parent session.
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--mode', 'rpc'");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--session-dir', task.sessionDir");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--session-id', task.sessionId");
    // 子 Pi 与父 Pi 使用同一条 project hard gate；权限门只经显式 bridge 回装。
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--no-approve'");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--no-extensions'");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain(
      "'--extension', config.bridgeExtension",
    );
  });

  it('keeps durable run controls hidden and read-only inside child PI', () => {
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain(
      "if (key.startsWith('CINDY_PI_SUBAGENT_')) delete childEnv[key]",
    );
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain(
      'childEnv.CINDY_PI_SUBAGENT_RUN_DIR = config.runDir',
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "const SUBAGENT_RUN_DIR_ENV = 'CINDY_PI_SUBAGENT_RUN_DIR'",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      'writeInsideAgentHome || writeInsideSubagentRun',
    );
  });

  it('reads model and provider from the runtime snapshot file, not from spawn-time env', () => {
    // env 在 spawn 时定型:会话中途 setModel 后子代理会继续用旧模型;provider 不一起传还会
    // 让网关与 BYOM 的同名模型落到默认 endpoint(pi-harness §3 要求 BYOM 直连原生 provider)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('function readRuntimeSnapshot()');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const runtime = readRuntimeSnapshot();");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("'--provider', task.provider");
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toContain("args.push('--model', task.model)");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('function resolveTaskModelRoutes(tasks, runtime)');
    // 不得再从 env 直接取模型(那就是被 review 指出的 stale 源)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('CINDY_PI_SUBAGENT_MODEL');
  });

  it('freezes the PI model catalog inside the durable run directory', () => {
    // Parent navigation closes its ephemeral configHome. A detached runner may
    // launch queued children later, so inheriting that directory would make
    // background survival depend on a file the parent deliberately deletes.
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "copyFileSync(join(configHome, 'models.json'), join(childConfigHome, 'models.json'))",
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('childConfigHome: childConfigHome');
  });

  it('persists a terminal failure if the detached runner cannot spawn', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("runner.once('error'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("state: 'failed'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("writePrivateJson(join(runDir, 'status.json')");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("runnerInstanceId: 'launch-pending-' + runId");
  });

  it('removes a partially staged durable run before reporting setup failure', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      'rmSync(runDir, { recursive: true, force: true })',
    );
  });

  it('reports failed when any parallel task failed, not only when all did', () => {
    // 部分失败被报成 completed 会让界面把整批任务显示为成功(greptile P1)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "report(aborted ? 'stopped' : failed > 0 ? 'failed' : 'completed'",
    );
  });

  it('does not register the tool when the host did not provide a pi binary path', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "if (typeof binary !== 'string' || binary.trim().length === 0) return;",
    );
  });

  it('fails closed when the routing snapshot is unavailable', () => {
    // host 写快照失败时会不传 runtime 文件 env 并删除该文件。扩展必须两处都失败关闭:
    // 注册期不暴露工具、使用期拒绝派发 —— 退回 pi 默认解析会把 BYOM / 本地 provider 的
    // 请求发到错误 endpoint,比「本次没有子代理」糟糕得多(review)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "if (typeof runtimeFile !== 'string' || runtimeFile.trim().length === 0) return;",
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('if (!runtime.provider) {');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('subagent is unavailable');
  });

  it('refuses to dispatch while the routing snapshot is pending, before anything spawns', () => {
    // host 在 set_model 的等待窗口里写的是带 `pending: true` 的新路由。放行这段窗口 = 子进程用
    // 一个尚未确认的 provider 起来,而 RPC 若被拒,host 能回滚文件却撤不回已经在跑的子进程
    // (review P1)。真实拒绝由集成用例(真 pi 进程 + 原生端点零请求)验证;这里钉的是
    // **顺序** —— 判断必须在任何 spawn 之前,否则"有这段代码"照样成立而进程已经起来了。
    const src = CINDY_SUBAGENT_EXTENSION_SOURCE;
    expect(src).toContain('pending: parsed.pending === true');
    expect(src).toContain('if (runtime.pending) {');
    expect(src).toContain('is not confirmed yet');
    const guard = src.indexOf('if (runtime.pending) {');
    const execute = src.indexOf('async execute(toolCallId');
    expect(guard).toBeGreaterThan(execute);
    const dispatch = src.indexOf('const launched = launchDurableRun(', guard);
    expect(dispatch).toBeGreaterThan(guard);
  });

  it('reports a terminal failed update before either pre-dispatch guard throws', () => {
    // 卡片模型在**没有任何** agent_task_update 时按"有工具结果 = completed"兜底,所以派发前直接
    // throw 会让这次被拒绝的委派在界面上立刻变绿(review)。两道闸都必须先发一帧终态 failed。
    // 真实效果由集成用例断言(事件流里出现 failed、不出现 completed);这里钉的是**顺序**:
    // report 的定义要排在两道闸之前,否则闸里根本调不到它(TDZ,而且改回去测试还得能红)。
    const src = CINDY_SUBAGENT_EXTENSION_SOURCE;
    const reportDefined = src.indexOf('const report = function (status: string');
    const snapshotGuard = src.indexOf('if (!runtime.provider) {');
    const pendingGuard = src.indexOf('if (runtime.pending) {');
    expect(reportDefined).toBeGreaterThan(-1);
    expect(snapshotGuard).toBeGreaterThan(reportDefined);
    expect(pendingGuard).toBeGreaterThan(reportDefined);
    // 每道闸内部:先 report('failed', …) 再 throw。
    for (const guard of [snapshotGuard, pendingGuard]) {
      const body = src.slice(guard, src.indexOf('}', src.indexOf('throw new Error(', guard)));
      const reported = body.indexOf("report('failed'");
      const thrown = body.indexOf('throw new Error(');
      expect(reported).toBeGreaterThan(-1);
      expect(reported).toBeLessThan(thrown);
    }
    // 而运行中那帧必须还在两道闸之后 —— 被拒时不该先闪一帧 running。
    // 带分号才是**语句**;不带的那个匹配会落在上面解释顺序的注释里(我先踩了一次)。
    expect(src.indexOf("report('running');")).toBeGreaterThan(pendingGuard);
  });


  it('ships as its own extension file rather than being folded into cindy-bridge', () => {
    expect(CINDY_SUBAGENT_EXTENSION_FILENAME).toBe('cindy-subagent.ts');
  });


  it('enforces a call-level output budget, not just a per-task one', () => {
    // 只限单项没用:8 个任务各 16k 拼起来 ~128k 字符注进父请求,一次委派就吃掉大半父上下文
    // (review)。成功与全失败两条返回路径都必须过总闸 —— text 在 throw 之前就已经收窄。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('const MAX_TOTAL_OUTPUT_CHARS = 32000;');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('function fitSectionsToBudget(sections)');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('fitSectionsToBudget(sections).join');
    // 全失败路径 throw 的是同一个已收窄的 text,不是未裁剪的原文。
    const budgeted = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const text = fitSectionsToBudget(sections).join');
    const thrown = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('throw new Error(text);');
    expect(budgeted).toBeGreaterThan(-1);
    expect(thrown).toBeGreaterThan(budgeted);
  });

  it('reports delegated usage components (with cost) for the parent turn accounting', () => {
    // 只报一个 totalTokens 的话父侧无从拆分 input/output/cache/cost,turn 记账与
    // register.ts 的持久化都拿不到委派花费(review)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('function emptyUsage()');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('usage: task.usage || emptyUsage()');
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) {
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(field + ': totals.usage.' + field + ',');
    }
  });




  it('declares the watchdog constants exactly once in the composed module', () => {
    // 主体与看门狗段是拼起来的:同名 const 声明两次 → 拼接后的模块直接 SyntaxError,
    // 整个扩展加载失败(连 cindy-bridge 之外的既有能力都不受影响,纯粹是子代理全哑)。
    const declarations = [...CINDY_SUBAGENT_EXTENSION_SOURCE.matchAll(/const PARENT_PID_ENV\b/g)];
    expect(declarations).toHaveLength(1);
    const intervals = [...CINDY_SUBAGENT_EXTENSION_SOURCE.matchAll(/const PARENT_WATCHDOG_INTERVAL_MS\b/g)];
    expect(intervals).toHaveLength(1);
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const PARENT_PID_ENV = '" + CINDY_SUBAGENT_PARENT_PID_ENV + "'");
  });

  it('installs the parent watchdog before the depth early-return', () => {
    // 子代理走的正是深度早返回那条分支。装在 return 之后 = 看门狗永远不生效,
    // 而字符串里"有这段代码"照样成立 —— 所以顺序必须钉住。
    const install = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('if (readDepth() > 0) installParentWatchdog();');
    const earlyReturn = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('if (readDepth() >= MAX_DEPTH) return;');
    expect(install).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(install);
  });


  it('registers no signal handlers (that would suppress pi\'s default terminate)', () => {
    // Node/Bun 里加一个 SIGTERM 监听就抑制了该信号的默认终止行为:pi 自身若没有别的处理器,
    // 收到 Cindy 的 SIGTERM 后不会退出,每次关会话都要等满 3s 宽限再被 SIGKILL。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("process.on('SIGTERM'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("process.on('SIGINT'");
  });
});
