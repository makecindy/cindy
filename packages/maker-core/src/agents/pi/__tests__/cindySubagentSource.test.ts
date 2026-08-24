import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('fails unknown Subagent models with the frozen list instead of forwarding a raw id', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain("' Available models: '");
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      "model \"' + task.model + '\" is not available in this session.'",
    );
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

  it('publishes the run directory before reading the fence, and spawns after', () => {
    // The Host cannot prevent this spawn by scanning: it happens here, inside
    // Pi, in an extension the Host never calls. A single fence read before the
    // spawn is not enough either — the Host could raise the fence and finish
    // scanning in the gap between the read and the write. What makes it
    // airtight is the *order*: the Host writes its fence and then scans, this
    // writes its run directory and then reads. Opposite orders, so at least one
    // side always sees the other. Both halves are pinned here because either
    // one moving re-opens the hole.
    const src = CINDY_SUBAGENT_EXTENSION_SOURCE;
    // Ownership is the file name: a shared one let a concurrent instance's
    // relaunch overwrite or delete this host's fence.
    expect(src).toContain("const LAUNCH_FENCE_PREFIX = '.launch-fence-'");
    expect(src).toContain(
      "join(fenceDir, LAUNCH_FENCE_PREFIX + String(hostPid) + LAUNCH_FENCE_SUFFIX)",
    );
    // The pre-per-host name stays readable through the upgrade window.
    expect(src).toContain("const LEGACY_LAUNCH_FENCE_FILENAME = '.launch-fence.json'");
    const launch = src.indexOf('function launchDurableRun(');
    const mkdir = src.indexOf('mkdirSync(runDir', launch);
    const publish = src.indexOf("writePrivateJson(join(runDir, 'status.json')", launch);
    const check = src.indexOf('if (launchFenceBlocksSpawn(runRoot, runtimeOwnerId)) {', launch);
    const spawned = src.indexOf('spawn(nodeExecutable', launch);
    expect(mkdir).toBeGreaterThan(launch);
    expect(publish).toBeGreaterThan(mkdir);
    expect(check).toBeGreaterThan(publish);
    expect(spawned).toBeGreaterThan(check);
    expect(src).toContain("const DELETED_TOMBSTONE_DIR = 'pi-subagent-deleted'");
    const firstTombstone = src.indexOf('if (parentTaskDeletedTombstone(runRoot)) {', launch);
    const lastTombstone = src.lastIndexOf('if (parentTaskDeletedTombstone(runRoot)) {', spawned);
    const lastStaging = src.lastIndexOf('copyFileSync(runnerFile, durableRunnerFile)', spawned);
    expect(firstTombstone).toBeGreaterThan(publish);
    expect(lastStaging).toBeGreaterThan(firstTombstone);
    expect(lastTombstone).toBeGreaterThan(lastStaging);
    expect(spawned).toBeGreaterThan(lastTombstone);
    expect(src).toContain('join(dirname(dirname(runRoot)), DELETED_TOMBSTONE_DIR, basename(runRoot))');
    // The published record has to be one the Host's scan can actually count.
    const staging = src.slice(publish, check);
    expect(staging).toContain("state: 'queued'");
    expect(staging).toContain('runtimeOwnerId: runtimeOwnerId');
    expect(staging).toContain("runnerInstanceId: 'launch-pending-' + runId");
    // A refusal rolls the directory back, or the Host would count a run that
    // never existed forever.
    expect(src.slice(check, spawned)).toContain('rmSync(runDir, { recursive: true, force: true })');
    // Only our own host's live fence counts: a fence from another instance
    // sharing the agent home, or one left by a dead host, must not block.
    const fn = src.slice(src.indexOf('function hostProcessIsAlive('), launch);
    expect(fn).toContain('fence.hostPid !== hostPid');
    expect(fn).toContain('process.kill(hostPid, 0)');
  });

  it('refuses to spawn while the fence is there but unreadable', () => {
    // The gate is evaluated from the shipped text rather than asserted on it:
    // what matters is the answer it gives, and the answer used to be "no fence"
    // for *every* failure — a Windows sharing conflict while the Host rewrites
    // the file, a permission error, or content caught mid-write. The launcher
    // then spawned straight through the window the fence exists to close, after
    // the boundary sweep had already run.
    const src = CINDY_SUBAGENT_EXTENSION_SOURCE;
    const body = src.slice(
      src.indexOf("const LAUNCH_FENCE_PREFIX = '.launch-fence-'"),
      src.indexOf('function launchDurableRun('),
    );
    const gateFor = (read: (file: string) => string): (root: string, owner: string) => boolean => (
      new Function(
        'readFileSync', 'join', 'dirname',
        `${body}\nreturn launchFenceBlocksSpawn;`,
      ) as (
        read: (file: string) => string,
        join: typeof path.join,
        dirname: typeof path.dirname,
      ) => (root: string, owner: string) => boolean
    )(read, path.join, path.dirname);
    const runRoot = path.join('/agent-home', 'runtime', 'pi-subagent-runs', 'session-1');
    const owner = `${process.pid}:session-1`;

    const enoent = (): never => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    // A file that is genuinely not there still means "no fence".
    expect(gateFor(enoent)(runRoot, owner)).toBe(false);

    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      expect(gateFor(() => {
        throw Object.assign(new Error(code), { code });
      })(runRoot, owner)).toBe(true);
    }
    // Readable but not parseable is the half-written window itself.
    expect(gateFor(() => '{"version":1,')(runRoot, owner)).toBe(true);
    // Only our own host's live fence still counts when it *can* be read.
    expect(gateFor(() => JSON.stringify({
      version: 1, hostPid: process.pid, createdAt: 1,
    }))(runRoot, owner)).toBe(true);
    expect(gateFor(() => JSON.stringify({
      version: 1, hostPid: 999_999, createdAt: 1,
    }))(runRoot, owner)).toBe(false);
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
    // Request boundaries come from the durable runner status. Dropping them in
    // the generated extension would force the parent back to an unpriceable
    // turn aggregate even though the child recorded each provider request.
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      'usageSegments: Array.isArray(task.usageSegments) ? task.usageSegments : [],',
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain(
      'usageSegments: totals.usageSegments.map(function (segment)',
    );
  });




  it('survives a Windows sharing violation while replacing status.json', () => {
    // Windows 没有「替换正被别人打开的文件」:host 轮询读 status.json 时 rename 抛
    // EPERM/EACCES/EBUSY。runner 里这条路径来自 50ms 的刷新定时器 —— 不重试 + 不 catch
    // 就是整个 runner 进程被一次瞬时共享冲突炸掉(Windows CI shard1 的真实根因),
    // 它 detach 出去的子进程也一起变成孤儿。
    for (const source of [CINDY_SUBAGENT_RUNNER_SOURCE, CINDY_SUBAGENT_EXTENSION_SOURCE]) {
      expect(source).toContain('const RENAME_RETRY_ATTEMPTS = 10;');
      expect(source).toMatch(/code === 'EPERM' \|\| code === 'EACCES' \|\| code === 'EBUSY'/);
      // 每个源码里只允许存在一处 rename 调用,且它必须在重试循环内 —— 否则「有重试代码」
      // 与「写路径真的用了重试」是两回事。
      expect([...source.matchAll(/(?<!\w)renameSync\(/g)]).toHaveLength(1);
    }
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toMatch(
      /function atomicWriteJson\(file, value\) \{[\s\S]*?renameWithRetry\(tmp, file\);/,
    );
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toMatch(
      /function renameWithRetry\(tmp, file\) \{\s*for \(let attempt = 0; ; attempt \+= 1\) \{\s*try \{\s*fs\.renameSync\(tmp, file\);/,
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toMatch(
      /function writePrivateJson\(file, value\) \{[\s\S]*?for \(let attempt = 0; ; attempt\+\+\) \{\s*try \{\s*renameSync\(tmp, file\);/,
    );
    // 定时器回调必须吞掉重试后仍失败的错误,交给下一个 tick。
    const runner = CINDY_SUBAGENT_RUNNER_SOURCE;
    const flush = runner.indexOf('function flushStatusNow()');
    expect(flush).toBeGreaterThan(-1);
    const body = runner.slice(flush, runner.indexOf('function flushTerminalStatus()', flush));
    expect(body).toMatch(/try \{\s*atomicWriteJson\(statusPath, statusPayload\(\)\);\s*\} catch/);
    // 终态记录走 flushTerminalStatus 的重试预算;result.json 是附件,见下一条用例。
    expect(runner).toContain('writeResultArtifact(terminalResultPayload(state.state));');
  });

  it('retries the terminal status write instead of dropping it on the floor', () => {
    // 终态那次写不能走 flushStatusNow 的「吞错 + scheduleStatus」:scheduleStatus 在
    // state.terminal 时直接 return,失败即永久丢弃,而 status.json 是唯一有生产读取方的
    // 终态记录(result.json 当前无人消费)—— 丢了就只能等它老化成 stale diagnostic。
    const runner = CINDY_SUBAGENT_RUNNER_SOURCE;
    const terminal = runner.indexOf('function flushTerminalStatus()');
    expect(terminal).toBeGreaterThan(-1);
    const body = runner.slice(terminal, runner.indexOf('\n  }\n', terminal));
    // 自己的重试循环 + 预算耗尽后只记一行日志(不 crash、不静默)。
    expect(body).toMatch(/for \(let attempt = 0; ; attempt \+= 1\) \{\s*try \{\s*atomicWriteJson\(statusPath, statusPayload\(\)\);/);
    expect(body).toContain('attempt >= TERMINAL_STATUS_ATTEMPTS - 1');
    expect(body).toContain('sleepSync(TERMINAL_STATUS_RETRY_MS)');
    expect(body).toContain("fail('terminal status write failed after retries: '");
    expect(runner).toContain('const TERMINAL_STATUS_ATTEMPTS = 20;');
    // 每个把 run 推向终态的位点都必须用它 —— 回退成 flushStatusNow 是静默丢终态。
    const terminalSites = [...runner.matchAll(/state\.terminal = true;/g)];
    expect(terminalSites.length).toBeGreaterThanOrEqual(3);
    for (const site of terminalSites) {
      const tail = runner.slice(site.index ?? 0);
      const terminalFlush = tail.indexOf('flushTerminalStatus();');
      const interimFlush = tail.indexOf('flushStatusNow();');
      expect(terminalFlush).toBeGreaterThan(-1);
      expect(interimFlush === -1 || terminalFlush < interimFlush).toBe(true);
    }
  });

  it('keeps the result artifact from deciding the terminal state', () => {
    // result.json 没有生产读取方,status.json 才是终态真值。附件写一旦能抛,就会:
    // 成功路径的 throw 掉进 .catch → state 被改写成 failed 并二次发布(假失败);
    // .catch 里的 throw 直接逃逸 → flushTerminalStatus 永不执行(停在非终态)。
    const runner = CINDY_SUBAGENT_RUNNER_SOURCE;
    const helper = runner.indexOf('function writeResultArtifact(payload)');
    expect(helper).toBeGreaterThan(-1);
    const body = runner.slice(helper, runner.indexOf('\n  }\n', helper));
    expect(body).toMatch(/try \{\s*atomicWriteJson\(resultPath, payload\);\s*state\.resultWritten = true;\s*\} catch/);
    expect(body).toContain("fail('result artifact write failed");
    // 附件写只能走这个不抛的封装 —— 直调 atomicWriteJson(resultPath, …) 就是把洞放回去。
    expect([...runner.matchAll(/atomicWriteJson\(resultPath/g)]).toHaveLength(1);
    // status 不得指向一个没写成的文件。
    expect(runner).toContain('resultPath: state.resultWritten ? resultPath : undefined,');
    // 每个终态位点的顺序:先钉死真实 state.state → 写附件 → 发布终态 status。
    for (const site of runner.matchAll(/state\.terminal = true;/g)) {
      const tail = runner.slice(site.index ?? 0);
      const stateAssigned = tail.indexOf('state.state = ');
      const artifact = tail.indexOf('writeResultArtifact(');
      const publish = tail.indexOf('flushTerminalStatus();');
      expect(stateAssigned).toBeGreaterThan(-1);
      expect(artifact).toBeGreaterThan(stateAssigned);
      expect(publish).toBeGreaterThan(artifact);
    }
  });

  it('escalates to its own handle when taskkill reports failure', () => {
    // spawnSync 的失败只体现在返回值(status / error)上,不进 catch。不检查 = Windows 上
    // fallback 永远不可达:runner 里的 child.kill 死代码,扩展里则干等满 grace 才升级。
    expect(CINDY_SUBAGENT_RUNNER_SOURCE).toMatch(
      /const killed = spawnSync\('taskkill'[\s\S]*?if \(killed\.error \|\| killed\.status !== 0\) child\.kill\(signal\);/,
    );
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toMatch(
      /const killed = spawnSync\('taskkill'[\s\S]*?if \(killed\.error \|\| killed\.status !== 0\) runner\.kill\('SIGKILL'\);/,
    );
  });

  it('records parent start time and checks process identity in the runner watchdog', () => {
    expect(CINDY_SUBAGENT_EXTENSION_SOURCE).toContain('parentStartTimeSec: Math.round(Date.now() / 1000 - process.uptime())');
    const runner = CINDY_SUBAGENT_RUNNER_SOURCE;
    expect(runner).toContain('function parentInstanceAlive()');
    expect(runner).toContain('function probeProcessStartTimeSec(pid)');
    expect(runner).toContain('if (!parentInstanceAlive())');
    expect(runner).not.toMatch(
      /parentWatchdogTimer = setInterval\(function \(\) \{\s*let alive = true;\s*try \{ process\.kill\(config\.parentPid, 0\);/,
    );
  });

  it('does not let a truncation marker push the transcript past the cap', () => {
    const runner = CINDY_SUBAGENT_RUNNER_SOURCE;
    const fn = runner.indexOf('function safeAppendTranscript');
    expect(fn).toBeGreaterThan(-1);
    const body = runner.slice(fn, runner.indexOf('function main()', fn));
    expect(body).toContain('const markerBytes = Buffer.byteLength(marker, \'utf8\');');
    expect(body).toContain('if (state.transcriptBytes + markerBytes <= MAX_TRANSCRIPT_BYTES)');
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

  it('marks durable terminal snapshots as terminal observations', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');
    expect(source).toContain("kind: terminal ? 'terminal' : 'spawn'");
  });

  it('does not store an English resume prefix as the run title', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../pi-subagent-runs.ts'),
      'utf8',
    );
    expect(source).not.toContain('Resumed Subagent');
    expect(source).toContain('title: sourceConfig.title,');
  });

  it('writes CINDY_PI_BASH_PACKAGE_HOME into the durable child env before spawn (#3132)', () => {
    // 父 bridge 会消费并删除该 env。durable runner 才是真正 spawn Pi child 的地方，
    // 必须在 spawn 前写回 posix 派生路径，否则子 bridge 无法解析 bash 隔离 home。
    const src = CINDY_SUBAGENT_RUNNER_SOURCE;
    expect(src).toContain(
      "childEnv.CINDY_PI_BASH_PACKAGE_HOME = path.posix.join(config.childConfigHome, 'bash-package-home');",
    );
    expect(src).toContain('path.isAbsolute(config.childConfigHome)');
    const writeBack = src.indexOf(
      "childEnv.CINDY_PI_BASH_PACKAGE_HOME = path.posix.join(config.childConfigHome, 'bash-package-home')",
    );
    const spawnCall = src.indexOf('spawn(config.binary, childArgs');
    expect(writeBack).toBeGreaterThan(-1);
    expect(spawnCall).toBeGreaterThan(writeBack);
  });
});
