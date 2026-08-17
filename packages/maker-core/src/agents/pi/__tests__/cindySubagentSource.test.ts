import { describe, expect, it } from 'vitest';

import { PI_SUBAGENT_TOOL_NAME } from '@cindy/maker-shared/agent-task';

import {
  CINDY_SUBAGENT_ENV,
  CINDY_SUBAGENT_EXTENSION_FILENAME,
  CINDY_SUBAGENT_EXTENSION_SOURCE,
  CINDY_SUBAGENT_PARENT_PID_ENV,
  CINDY_SUBAGENT_TOOL_NAME,
} from '../cindy-subagent-source.js';
import { PI_SUBAGENT_PROGRESS_MARKER } from '../subagent-progress.js';

/**
 * 注入源码是字符串常量,typecheck 与 vitest 都进不去,只能靠结构性断言守。这里守的是
 * 「改一处忘另一处就静默失效」的那几条,不是复读实现细节。
 */
describe('cindy-subagent extension source', () => {
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
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toMatch(/TASK_TIMEOUT_MS\s*=/);
    // 子代理不写会话文件,不污染 Cindy 的会话 JSONL。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("'--no-session'");
    // 子 Pi 与父 Pi 使用同一条 project hard gate；权限门只经显式 bridge 回装。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("'--no-approve'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("'--no-extensions'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "'--extension', join(configHome, 'extensions', 'cindy-bridge.ts')",
    );
  });

  it('reads model and provider from the runtime snapshot file, not from spawn-time env', () => {
    // env 在 spawn 时定型:会话中途 setModel 后子代理会继续用旧模型;provider 不一起传还会
    // 让网关与 BYOM 的同名模型落到默认 endpoint(pi-harness §3 要求 BYOM 直连原生 provider)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('function readRuntimeSnapshot()');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const runtime = readRuntimeSnapshot();");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("args.push('--provider', runtime.provider)");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("args.push('--model', runtime.model)");
    // 不得再从 env 直接取模型(那就是被 review 指出的 stale 源)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('CINDY_PI_SUBAGENT_MODEL');
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
    const spawn = src.indexOf('child = spawn(binary, args');
    expect(guard).toBeGreaterThan(execute);
    // runTask 里的 spawn 在源码里位于 execute 之前(函数声明顺序),所以不能只比字符位置 ——
    // 关键是这道闸在 execute 的**早返回段**里,即在 tasks 循环启动之前。
    expect(spawn).toBeLessThan(execute);
    const dispatch = src.indexOf('runTask(', guard);
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

  it('defers settling to process close so grace-period usage is still counted', () => {
    // kill() 到 SIGKILL 之间约 2 秒宽限里子进程仍会吐 message_end,那是真实产生的 token/cost。
    // 原来 abort/timeout 立刻 finish + 在 JSON.parse 之前整条短路,这段用量直接丢掉(review)。
    // 单纯"解析但不上报"也救不回来:promise 已 resolve,调用方紧接着读走快照,之后改 totals
    // 没人再看。所以收口必须推迟到进程真的 'close'。
    const src = CINDY_SUBAGENT_EXTENSION_SOURCE;
    // abort 与 timeout 都只置原因 + 杀 + 兜底,不再直接 finish。
    expect(src).toContain("terminationReason = 'aborted';");
    expect(src).toContain("terminationReason = 'timeout';");
    expect(src).toContain('armSettleFallback(');
    // 真正的收口在 close 分支里,按 terminationReason 决定文案。
    const closeAt = src.indexOf("child.on('close'");
    expect(src.indexOf('if (terminationReason !== null) {', closeAt)).toBeGreaterThan(closeAt);
    // 'close' 万一不来,兜底定时器仍要收口,不能把父 turn 永久挂住。
    expect(src).toMatch(/settleFallbackTimer = setTimeout\(/);
    // 守卫仍在(只挡上报),但它现在只对"兜底已强行收口"生效。
    const feedGuard = src.indexOf('const feed = createLineReader');
    expect(src.indexOf('if (settled) return;', feedGuard)).toBeGreaterThan(feedGuard);
  });

  it('ships as its own extension file rather than being folded into cindy-bridge', () => {
    expect(CINDY_SUBAGENT_EXTENSION_FILENAME).toBe('cindy-subagent.ts');
  });

  it('strips the MCP bridge from the child env so subagents do not open MCP transports', () => {
    // 子进程继承 PI_CODING_AGENT_DIR → 会加载 cindy-bridge(权限门要靠这个)。bridge 一见到
    // CINDY_PI_MCP_BRIDGE 就逐个 connect 所有 MCP server 并持有有状态 transport,而子代理的
    // --tools 白名单里根本没有 MCP 工具 —— 纯浪费:每个子代理一整套连接、并发 4 单批最多 8,
    // 且子代理不显式 close。实测:一个 depth=1 的 pi 进程对 fake MCP server 发了 3 次请求,
    // 剥掉该 env 后为 0,而 bridge 的 bash 覆盖与权限门注册在 MCP 段**之前**,不受影响。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("const MCP_BRIDGE_ENV = 'CINDY_PI_MCP_BRIDGE'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('delete childEnv[MCP_BRIDGE_ENV];');
    // 权限门与网关路由必须**保留**:这两个被剥掉才是真事故(子代理越权 / 打错 endpoint)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('delete childEnv[RUNTIME_FILE_ENV]');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("delete childEnv['CINDY_PI_PERMISSION_FILE']");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("delete childEnv['PI_CODING_AGENT_DIR']");
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
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('totals.cost += cost');
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) {
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(field + ': totals.usage.' + field + ',');
    }
  });

  it('does not SIGKILL a pid it no longer owns', () => {
    // SIGTERM 后的 2 秒宽限里子进程通常已经退了。原来那发 SIGKILL 既没存定时器(进程退出后
    // 仍多挂 2 秒)也不复查存活 —— 一旦 pid 被系统回收复用,这一发就打到无关进程上(review)。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('let killTimer = null;');
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('killTimer = setTimeout(');
    // 强杀前必须先确认子进程还没退。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "if (child.exitCode !== null || child.signalCode !== null) return;",
    );
    // 存活复查必须在 SIGKILL **之前**。
    const guard = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('if (child.exitCode !== null');
    const sigkill = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf("child.kill('SIGKILL')", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(sigkill).toBeGreaterThan(guard);
    // close / error 两条退出路径都要清定时器。
    // 锚点必须是**真** error handler(带 err 形参);中止分支那个吞错 stub 是无形参的,
    // 用它当锚点会让断言落在错误的位置(我加中止分支时就先踩了一次)。
    for (const handler of ["child.on('close'", "child.on('error', function (err)"]) {
      const at = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf(handler);
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE.slice(at, at + 320)).toContain('clearTimeout(killTimer)');
    }
  });


  it('never spawns a child once the batch is aborted', () => {
    // 批次取消时 worker 车道里可能还排着任务。原来它们照样先 spawn、再走 aborted 早返回,而那个
    // return 在注册 stdout/error/close **之前**:子进程永留 liveChildren,且 spawn 失败会变成
    // 无人监听的 'error' 事件 —— Node 里直接抛出,能把父 pi 进程带走(review)。
    const source = CINDY_SUBAGENT_EXTENSION_SOURCE;
    const runTaskAt = source.indexOf('function runTask(');
    const preCheck = source.indexOf('if (signal && signal.aborted === true) {', runTaskAt);
    const spawnAt = source.indexOf('child = spawn(binary, args', runTaskAt);
    expect(preCheck).toBeGreaterThan(runTaskAt);
    // 检查必须在 spawn **之前**。
    expect(preCheck).toBeLessThan(spawnAt);
    // 残余竞态(检查后、spawn 完成前才 abort)那条早返回要自己摘 liveChildren + 吞 error。
    const innerAbort = source.indexOf('if (signal.aborted) {', spawnAt);
    const innerBody = source.slice(innerAbort, innerAbort + 520);
    expect(innerBody).toContain('liveChildren.delete(child)');
    expect(innerBody).toContain("child.on('error'");
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

  it('tracks live children and reaps them when the parent exits normally', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('liveChildren.add(child)');
    // 摘除必须挂在进程真正结束的 'close' / 'error' 上,**不能**挂在 finish() 里:超时与中止
    // 都是先 finish 再进 SIGKILL 宽限期,进程那时还活着,这段窗口内父进程退出仍要杀它。
    const finishStart = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const finish = function');
    const finishEnd = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const kill = function', finishStart);
    expect(finishStart).toBeGreaterThan(-1);
    expect(finishEnd).toBeGreaterThan(finishStart);
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE.slice(finishStart, finishEnd)).not.toContain('liveChildren.delete');
    // 锚点必须是**真** error handler(带 err 形参);中止分支那个吞错 stub 是无形参的,
    // 用它当锚点会让断言落在错误的位置(我加中止分支时就先踩了一次)。
    for (const handler of ["child.on('close'", "child.on('error', function (err)"]) {
      const at = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf(handler);
      expect(at).toBeGreaterThan(-1);
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE.slice(at, at + 240)).toContain('liveChildren.delete(child)');
    }
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("process.on('exit', reapLiveChildren)");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("childEnv[PARENT_PID_ENV] = String(process.pid)");
  });

  it('registers no signal handlers (that would suppress pi\'s default terminate)', () => {
    // Node/Bun 里加一个 SIGTERM 监听就抑制了该信号的默认终止行为:pi 自身若没有别的处理器,
    // 收到 Cindy 的 SIGTERM 后不会退出,每次关会话都要等满 3s 宽限再被 SIGKILL。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("process.on('SIGTERM'");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain("process.on('SIGINT'");
  });
});
