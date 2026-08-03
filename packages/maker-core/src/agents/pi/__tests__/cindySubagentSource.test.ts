import { describe, expect, it } from 'vitest';

import { PI_SUBAGENT_TOOL_NAME } from '@cindy/maker-shared/agent-task';

import {
  CINDY_SUBAGENT_ENV,
  CINDY_SUBAGENT_EXTENSION_FILENAME,
  CINDY_SUBAGENT_EXTENSION_SOURCE,
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

  it('ships as its own extension file rather than being folded into cindy-bridge', () => {
    expect(CINDY_SUBAGENT_EXTENSION_FILENAME).toBe('cindy-subagent.ts');
  });
});
