import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnNative } from 'node:child_process';
import spawn from 'cross-spawn';
import matter from 'gray-matter';
import type { AgentAdapter } from './types.js';

export interface CodexAdapterOptions {
  command?: string;
  model?: string;
  timeoutSeconds?: number;
  refreshTimeoutSeconds?: number;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  return {
    name: 'codex',
    async rewriteKnowledge(input) {
      return runCodex(
        options,
        [
          input.instruction,
          '根据以下旧知识和 Git diff 更新正文。',
          '--- BEGIN OLD KNOWLEDGE ---',
          input.oldContent,
          '--- END OLD KNOWLEDGE ---',
          '--- BEGIN DIFF ---',
          input.diff,
          '--- END DIFF ---',
          OUTPUT_RULES,
        ].join('\n\n'),
        input.cwd ?? process.cwd(),
        options.timeoutSeconds ?? 120,
        input.oldContent,
      );
    },
    async refreshKnowledge(input) {
      return runCodex(
        options,
        [
          input.instruction,
          input.contextHint,
          '请使用原生只读工具读取、搜索上述范围的源码，再生成项目知识。不要修改文件。',
          '--- BEGIN OLD KNOWLEDGE ---',
          input.oldContent,
          '--- END OLD KNOWLEDGE ---',
          OUTPUT_RULES,
        ].join('\n\n'),
        input.cwd,
        options.refreshTimeoutSeconds ?? 600,
        input.oldContent,
      );
    },
  };
}

// 这是本次知识维护的用户输入，不修改 Cindy 或 Codex 的全局 system prompt。
const OUTPUT_RULES =
  '最终消息只输出 Markdown 正文，以标题开头，不含 frontmatter 或过程说明，不用代码围栏包裹全文。' +
  '保留旧知识的二级章节，尤其是“## 是什么”；保留演进备忘的既有内容。文件由宿主统一写入。';
const MAX_OUTPUT_BYTES = 1024 * 1024;

async function runCodex(
  options: CodexAdapterOptions,
  prompt: string,
  cwd: string,
  timeoutSeconds: number,
  oldContent: string,
): Promise<string> {
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds * 1000 > 2_147_483_647
  ) {
    throw new Error('codex adapter: 超时必须是有效的正数（秒）。');
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-context-codex-'));
  const outputPath = path.join(tempDir, 'last-message.md');
  try {
    const args = [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--ephemeral',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
    ];
    if (options.model) args.push('--model', options.model);
    args.push('-');
    await execute(options.command ?? 'codex', args, prompt, cwd, timeoutSeconds * 1000);
    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_OUTPUT_BYTES) {
      throw new Error('codex adapter: 最终输出缺失或超过 1 MiB，旧知识将保留。');
    }
    const body = (await fs.readFile(outputPath, 'utf8')).trim();
    if (!/^#{1,2} /u.test(body)) {
      throw new Error('codex adapter: 最终输出不是有效的 Markdown 正文，旧知识将保留。');
    }
    const sections = markdownSections(body);
    const required = markdownSections(matter(oldContent).content);
    if (
      !sections.get('是什么')?.trim() ||
      [...required.keys()].some((name) => !sections.has(name))
    ) {
      throw new Error('codex adapter: 最终正文缺少既有二级章节或“是什么”为空，旧知识将保留。');
    }
    return body + '\n';
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// 忽略代码示例中的标题，避免将示例误判为知识章节。
function markdownSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^##\s+(.+?)\s*$/u.exec(line)?.[1];
    if (heading) {
      // TOC 消费第一个同名章节，后续重复标题不能掩盖空摘要。
      current = sections.has(heading) ? undefined : heading;
      if (current) sections.set(current, '');
    } else if (current) sections.set(current, sections.get(current) + '\n' + line);
  }
  return sections;
}

function execute(
  command: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // cross-spawn 处理 Windows npm .cmd 入口及参数转义，prompt 始终通过 stdin。
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let completed = false;
    let failed = false;
    let pendingLine = '';
    let failure: Error | undefined;
    let settled = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      // 子孙进程可能仍持有管道，不能无限等待 close。
      reapTimer = setTimeout(() => finish(failure), 2000);
      if (child.pid) {
        if (process.platform === 'win32') {
          // 仅回收本次启动的进程树，不按进程名终止其它 Codex 任务。
          const killer = spawnNative('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            child.kill();
          });
          killer.on('close', (code) => {
            if (code !== 0) child.kill();
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      } else {
        child.kill();
      }
    };
    const timer = setTimeout(
      () => stop(new Error(`codex adapter: 执行超时（${timeoutMs}ms）。`)),
      timeoutMs,
    );
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string } | null;
        if (event?.type === 'turn.started') completed = false;
        if (event?.type === 'turn.completed') completed = true;
        if (event?.type === 'turn.failed') failed = true;
      } catch {
        stop(new Error('codex adapter: CLI 返回了无效的 JSONL 事件。'));
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pendingLine += chunk;
      let end: number;
      while ((end = pendingLine.indexOf('\n')) !== -1) {
        const line = pendingLine.slice(0, end);
        pendingLine = pendingLine.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES) {
          stop(new Error('codex adapter: CLI 事件超过 1 MiB。'));
          return;
        }
        consumeLine(line);
      }
      if (Buffer.byteLength(pendingLine) > MAX_OUTPUT_BYTES)
        stop(new Error('codex adapter: CLI 事件超过 1 MiB。'));
    });
    // 错误摘要可能包含命令、源码或凭证，不能落入 stale_reason 或 CLI 日志。
    child.stderr?.resume();
    child.stdin?.on('error', () => stop(new Error('codex adapter: 无法向 CLI 发送维护请求。')));
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new Error(
          error.code === 'ENOENT'
            ? 'codex adapter: 找不到 Codex CLI，请安装或设置 agent_options.command。'
            : 'codex adapter: 无法启动 Codex CLI，请检查 agent_options.command。',
        ),
      ),
    );
    child.on('close', (code) => {
      if (pendingLine) consumeLine(pendingLine);
      if (failure) finish(failure);
      else if (code !== 0 || failed || !completed) {
        finish(
          new Error('codex adapter: CLI 未成功完成；请检查 Codex 登录、模型和运行环境后重试。'),
        );
      } else finish();
    });
    child.stdin?.end(prompt);
  });
}
