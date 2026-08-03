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
    // 必须**不**传 --no-extensions:否则子进程不加载 cindy-bridge,权限门对子代理失效。
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).not.toContain('--no-extensions');
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

  it('drops late child output after the task already settled', () => {
    // kill() 到 SIGKILL 之间有约 2 秒宽限,子进程仍可能吐 stdout;终态上报后再回调
    // onProgress 会把 stopped/failed 重新写成 running(review)。解析前就短路。
    const feedGuard = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const feed = createLineReader');
    const parseAt = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('JSON.parse(line)');
    const settledGuard = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('if (settled) return;', feedGuard);
    expect(feedGuard).toBeGreaterThan(-1);
    expect(settledGuard).toBeGreaterThan(feedGuard);
    // 守卫必须在 JSON.parse 之前。
    expect(settledGuard).toBeLessThan(parseAt);
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
    for (const handler of ["child.on('close'", "child.on('error'"]) {
      const at = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf(handler);
      expect(CINDY_SUBAGENT_EXTENSION_SOURCE.slice(at, at + 320)).toContain('clearTimeout(killTimer)');
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

  it('tracks live children and reaps them when the parent exits normally', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('liveChildren.add(child)');
    // 摘除必须挂在进程真正结束的 'close' / 'error' 上,**不能**挂在 finish() 里:超时与中止
    // 都是先 finish 再进 SIGKILL 宽限期,进程那时还活着,这段窗口内父进程退出仍要杀它。
    const finishStart = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const finish = function');
    const finishEnd = CINDY_SUBAGENT_EXTENSION_SOURCE.indexOf('const kill = function', finishStart);
    expect(finishStart).toBeGreaterThan(-1);
    expect(finishEnd).toBeGreaterThan(finishStart);
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE.slice(finishStart, finishEnd)).not.toContain('liveChildren.delete');
    for (const handler of ["child.on('close'", "child.on('error'"]) {
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
