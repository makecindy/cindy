/**
 * 前置检查脚本的 AI 生成器:用户用自然语言描述"什么情况才需要跑这个任务",
 * 经 utility model(requestUtilityText,带供应商回退链)生成一个自包含的
 * Node.js 检查脚本,落盘后返回可直接填进 preRunHook.command 的命令。
 *
 * 设计要点(规则 9:确定性逻辑全在代码里,LLM 只产脚本正文):
 *   - 统一生成 **Node ESM (.mjs)** 脚本:跨平台唯一可行的公共载体
 *     (bash Windows 没有、cmd/PowerShell macOS 没有;Cindy 用户机器上
 *     node 由开发环境保证,生成的命令显式写 `node`,与 hook 执行器的
 *     Windows shebang 限制天然兼容)。
 *   - 代码负责:prompt 组装、代码块提取、文件名/路径解析、落盘、命令拼装;
 *     模型只负责脚本正文。提取失败 → 明确报错,绝不落半成品。
 *   - 落盘位置:项目任务 → `<workingDir>/scripts/schedule-checks/<name>.mjs`
 *     (随项目走、可进 git);无目录任务(对话/heartbeat)→ 注入的 fallbackDir
 *     (userData/schedule-hooks),命令用绝对路径。
 *   - 修改流:currentCommand 能解析出我们生成过的脚本路径且文件存在 →
 *     读入现有内容随 prompt 提交,并**覆写同一路径**(命令不变,复用无感)。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type { AgentKind, Maker } from '@cindy/maker-core';
import type { PreRunHookRunResult } from '@cindy/maker-scheduler';
import type { UtilityTextFailure, UtilityTextResult } from '../../shared/utilityTextResult.js';

/** 生成请求的输入(IPC 层已完成参数校验)。 */
export interface GenerateHookScriptInput {
  /** 用户的自然语言描述:什么情况才需要跑任务。 */
  description: string;
  scheduleName?: string;
  /** 项目任务的工作目录;无目录任务不传 → 落 fallbackDir。 */
  workingDir?: string;
  /** 修改流:当前命令(尝试解析出已生成脚本的路径并覆写)。 */
  currentCommand?: string;
  /** 任务实际选择的供应商；显式值优先于 utility model 默认回退链。 */
  providerId?: string;
  /** 任务实际使用的 agent runtime。 */
  agentKind?: AgentKind;
  /** 任务实际选择的模型；自定义供应商缺省时取该 runtime 的首个模型。 */
  model?: string;
}

export interface GenerateHookScriptResult {
  /** 可直接填进 preRunHook.command 的命令。 */
  command: string;
  /** 脚本落盘的绝对路径。 */
  filePath: string;
  /** 脚本内容(UI 预览用)。 */
  content: string;
}

export interface HookScriptGeneratorDeps {
  /** description 生成模式必需;script 直装模式可为 null(不触发 LLM)。 */
  maker: Maker | null;
  /** 无 workingDir 时的落盘目录(userData/schedule-hooks),由 IPC 层注入。 */
  fallbackDir: string;
  logger?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void };
  /** 测试注入;缺省走 requestUtilityText。 */
  requestText?: (
    maker: Maker,
    prompt: string,
    opts: {
      maxTokens: number;
      timeoutMs: number;
      providerId?: string;
      agentKind?: AgentKind;
      model?: string;
    },
  ) => Promise<UtilityTextResult>;
  /**
   * 测试注入;缺省走 hook-runtimes.hasSystemNode(探测系统 node)。
   * false → 生成的命令用 `xdt-node` 前缀(app 自带 Electron 运行时兜底,
   * 见 pre-run-hook.resolveHookCommand),裸机用户也能跑。
   */
  hasSystemNode?: () => Promise<boolean>;
}

/** Stable error codes consumed by both the scheduler IPC and scheduler MCP. */
export type HookScriptUtilityModelErrorCode =
  | 'UTILITY_MODEL_NO_CANDIDATE'
  | 'UTILITY_MODEL_ALL_CANDIDATES_FAILED'
  | 'UTILITY_MODEL_EMPTY_RESPONSE'
  | 'UTILITY_MODEL_TIMEOUT';

const UTILITY_MODEL_ERROR_CODE: Record<UtilityTextFailure['reason'], HookScriptUtilityModelErrorCode> = {
  no_candidate: 'UTILITY_MODEL_NO_CANDIDATE',
  all_candidates_failed: 'UTILITY_MODEL_ALL_CANDIDATES_FAILED',
  empty_response: 'UTILITY_MODEL_EMPTY_RESPONSE',
  timeout: 'UTILITY_MODEL_TIMEOUT',
};

/** Expected utility-model exhaustion with a credential-safe structured diagnostic. */
export class HookScriptUtilityModelError extends Error {
  readonly code: HookScriptUtilityModelErrorCode;

  constructor(readonly failure: UtilityTextFailure) {
    const code = UTILITY_MODEL_ERROR_CODE[failure.reason];
    const attempts = failure.attempts
      .map((attempt) =>
        `${attempt.providerId}/${attempt.model}:${attempt.reason}${attempt.httpStatus !== undefined ? `(${attempt.httpStatus})` : ''}`)
      .join(', ');
    super(`[${code}] ${failure.reason}${attempts ? `; attempts=${attempts}` : ''}`);
    this.name = 'HookScriptUtilityModelError';
    this.code = code;
  }
}

/** 生成脚本的输出 token 预算与超时:脚本 ≤ ~120 行,4k token 充裕;网络+推理放宽到 90s。 */
const GENERATE_MAX_TOKENS = 4096;
const GENERATE_TIMEOUT_MS = 90_000;
/** 修改流读入现有脚本的上限,防超长文件撑爆 prompt。 */
const CURRENT_SCRIPT_CAP = 16 * 1024;

/**
 * 组装生成 prompt(纯函数,可测)。协议、平台、退出码语义全部显式写给模型;
 * 模型只输出一个 fenced code block。
 */
export function buildHookScriptPrompt(input: {
  description: string;
  platform: NodeJS.Platform;
  scheduleName?: string;
  workingDir?: string;
  currentScript?: string;
}): string {
  const lines = [
    'You are writing a pre-run gate script for a task scheduler. The script decides whether a scheduled AI-agent task should run this round.',
    '',
    'Hard protocol (must follow exactly):',
    '- The script is executed with Node.js (>= 18) as an ES module (.mjs file).',
    '- Exit code 0 = let the task run this round. Exit code 2 = skip this round. Any other exit code, crash, or timeout blocks the task (fail-closed), so prefer explicit process.exit(0) / process.exit(2).',
    '- The working directory is the task project directory (if any). stdin receives a JSON payload ({ scheduleId, scheduleName, firedAt, workingDir, lastFinishedAt }) — reading it is optional.',
    '- CAUTION: lastFinishedAt is also refreshed by rounds this very script skips (exit 2). Never build "run only if enough time passed since the last real run" on top of it — the script would lock itself out forever. Persist your own timestamp file if you need that.',
    '- Use only Node.js built-in modules (node:fs, node:child_process, node:https, ...). No npm dependencies.',
    '- External CLI tools (git, gh, curl ...) may be invoked via child_process. Unexpected failures must exit non-zero so the scheduler blocks the task instead of silently bypassing the gate.',
    '- Keep it short (usually < 80 lines), with brief comments in Chinese explaining the check.',
    `- Target platform: ${input.platform === 'win32' ? 'Windows' : input.platform === 'darwin' ? 'macOS' : 'Linux'}. Avoid platform-specific shell syntax; do everything inside Node.`,
    '',
    `Task name: ${input.scheduleName?.trim() || '(unnamed)'}`,
    input.workingDir ? `Project directory at run time: ${input.workingDir}` : 'No fixed project directory (script must not assume repo-relative paths unless the user description implies one).',
    '',
    'User requirement (what condition should allow the task to run):',
    input.description.trim(),
  ];
  if (input.currentScript) {
    lines.push(
      '',
      'An existing script is being MODIFIED. Keep its working parts unless the new requirement says otherwise. Current script:',
      '```js',
      input.currentScript,
      '```',
    );
  }
  lines.push(
    '',
    'Output ONLY the complete script wrapped in a single ```js fenced code block. No explanation before or after.',
  );
  return lines.join('\n');
}

/**
 * 从模型响应里提取脚本正文(纯函数,可测):
 * 优先取第一个 fenced code block(```js / ```javascript / ```mjs / 裸 ```);
 * 无 code block 且全文看起来就是代码(不含 markdown 标题/解释段)→ 原文;
 * 否则返回 null(调用方报"生成失败",绝不落半成品)。
 */
export function extractScriptFromResponse(text: string): string | null {
  const fence = /```(?:js|javascript|mjs|node)?[ \t]*\r?\n([\s\S]*?)```/m.exec(text);
  if (fence) {
    const body = fence[1].trim();
    return body.length > 0 ? body : null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 无 fence:仅当首行就是代码形态(import / const / #! / 注释)才接受原文
  if (/^(import |const |let |function |#!|\/\/|\/\*|'use strict')/m.test(trimmed.split(/\r?\n/, 1)[0] ?? '')) {
    return trimmed;
  }
  return null;
}

/** 从任务名/描述派生文件 slug(纯函数,可测):ASCII 字母数字连字;中文等非 ASCII 回落 'check'。 */
export function hookScriptSlug(scheduleName?: string, description?: string): string {
  for (const source of [scheduleName, description]) {
    const slug = (source ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (slug.length >= 3) return slug;
  }
  return 'check';
}

/**
 * 从当前命令解析出"我们生成过的脚本路径"(纯函数,可测)。
 * 只认本生成器产出的形态:`node|xdt-node "<path>.mjs"` / `'<path>.mjs'`(POSIX
 * shellQuotePath 的单引号形态)/ 裸 `<path>.mjs`;其它命令(用户手写/多段管道)
 * 一律返回 null,不做危险的通用解析。含内嵌引号转义('\''')的极端路径不识别,
 * 后果只是修改流新建文件而非覆写,方向保守。
 */
export function parseGeneratedScriptPath(command: string | undefined): string | null {
  if (!command) return null;
  const m = /^(?:node|xdt-node)\s+(?:"([^"]+\.mjs)"|'([^']+\.mjs)'|(\S+\.mjs))\s*$/.exec(
    command.trim(),
  );
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

interface ParsedSingleFileHookCommand {
  prefix: string;
  scriptPath: string;
  extensions: ReadonlySet<string>;
}

const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PYTHON_SCRIPT_EXTENSIONS = new Set(['.py']);
const SHELL_SCRIPT_EXTENSIONS = new Set(['.sh']);
const POWERSHELL_SCRIPT_EXTENSIONS = new Set(['.ps1']);
const DIRECT_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.exe']);

function parsedPath(match: RegExpExecArray, offset: number): string {
  return match[offset] ?? match[offset + 1] ?? match[offset + 2];
}

/** Parse the single-script command shapes emitted by the scheduler UI/installer. */
function parseSingleFileHookCommand(command: string): ParsedSingleFileHookCommand | null {
  const trimmed = command.trim();
  let match = /^(node|xdt-node)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (match) {
    return {
      prefix: match[1],
      scriptPath: parsedPath(match, 2),
      extensions: NODE_SCRIPT_EXTENSIONS,
    };
  }
  match = /^(python|python3)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (match) {
    return {
      prefix: match[1],
      scriptPath: parsedPath(match, 2),
      extensions: PYTHON_SCRIPT_EXTENSIONS,
    };
  }
  match = /^(bash)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (match) {
    return {
      prefix: match[1],
      scriptPath: parsedPath(match, 2),
      extensions: SHELL_SCRIPT_EXTENSIONS,
    };
  }
  match = /^(powershell|pwsh)\s+-ExecutionPolicy\s+Bypass\s+-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(
    trimmed,
  );
  if (match) {
    return {
      prefix: `${match[1]} -ExecutionPolicy Bypass -File`,
      scriptPath: parsedPath(match, 2),
      extensions: POWERSHELL_SCRIPT_EXTENSIONS,
    };
  }
  match = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(trimmed);
  if (match) {
    return {
      prefix: '',
      scriptPath: parsedPath(match, 1),
      extensions: DIRECT_SCRIPT_EXTENSIONS,
    };
  }
  return null;
}

/**
 * Make a supported single-file hook command independent from its execution cwd.
 * Arbitrary shell commands (for example `pnpm check`) intentionally stay cwd-relative.
 */
export function stabilizeHookCommand(
  command: string,
  workingDir?: string,
  exists: (filePath: string) => boolean = existsSync,
): string {
  const parsed = parseSingleFileHookCommand(command);
  if (!parsed) return command;
  const extension = path.extname(parsed.scriptPath).toLowerCase();
  if (!parsed.extensions.has(extension)) return command;
  if (path.isAbsolute(parsed.scriptPath)) return command;
  if (!workingDir?.trim()) {
    throw new Error(
      `invalid pre-run hook configuration: cannot stabilize relative script without its original working directory: ${parsed.scriptPath}`,
    );
  }
  const absolutePath = path.resolve(workingDir, parsed.scriptPath);
  if (!exists(absolutePath)) {
    throw new Error(`invalid pre-run hook configuration: script not found: ${absolutePath}`);
  }
  const quotedPath = shellQuotePath(absolutePath);
  return parsed.prefix ? `${parsed.prefix} ${quotedPath}` : quotedPath;
}

/** 目标路径解析(纯函数,可测):修改流复用旧路径;新建避让已存在的同名文件。 */
export function resolveHookScriptPath(input: {
  workingDir?: string;
  fallbackDir: string;
  slug: string;
  reusePath?: string | null;
  exists: (p: string) => boolean;
}): { filePath: string; relativeToWorkingDir: boolean } {
  if (input.reusePath) {
    return { filePath: input.reusePath, relativeToWorkingDir: false };
  }
  const dir = input.workingDir?.trim()
    ? path.join(input.workingDir, 'scripts', 'schedule-checks')
    : input.fallbackDir;
  const relativeToWorkingDir = !!input.workingDir?.trim();
  let candidate = path.join(dir, `${input.slug}.mjs`);
  let n = 2;
  while (input.exists(candidate)) {
    candidate = path.join(dir, `${input.slug}-${n}.mjs`);
    n += 1;
  }
  return { filePath: candidate, relativeToWorkingDir };
}

/**
 * 平台 shell 转义(与 renderer scheduleFormLogic 的 quote 同口径,保持两份同步):
 * POSIX 单引号包裹(单引号内无任何解释,内嵌单引号按 '\'' 拼接)——双引号内
 * $()/`` /$var 照样展开,不是转义;Windows 双引号包裹(文件名不允许含 ",
 * cmd 引号内 & ( ) ^ 为字面量;%VAR% 展开是 cmd 关不掉的边缘,接受)。
 */
function shellQuotePath(p: string): string {
  return process.platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * 由落盘路径拼回命令(可测):项目内用相对路径(cwd=workingDir),否则绝对
 * 路径做平台 shell 转义。runner='xdt-node' = 系统无 node 时的 app 自带运行时兜底前缀。
 */
export function buildHookCommand(
  filePath: string,
  workingDir?: string,
  runner: 'node' | 'xdt-node' = 'node',
): string {
  if (workingDir?.trim()) {
    const rel = path.relative(workingDir, filePath);
    // 脚本确实落在 workingDir 之下才用相对路径(修改流的旧路径可能在 fallbackDir)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      // 统一正斜杠:node 两端都认,命令展示也更干净。命令经 shell:true 执行,
      // 相对路径含 shell 元字符(空格 & ( ) $ 等,修改流复用的旧路径可能任意)时
      // 必须转义;生成器自产路径(slug + scripts/schedule-checks/)恒为安全字符集。
      const relPosix = rel.split(path.sep).join('/');
      return /^[A-Za-z0-9_\-./]+$/.test(relPosix)
        ? `${runner} ${relPosix}`
        : `${runner} ${shellQuotePath(relPosix)}`;
    }
  }
  return `${runner} ${shellQuotePath(filePath)}`;
}

/**
 * 选定脚本执行方:系统 node 可用 → 'node';否则 'xdt-node'(app 自带运行时兜底)。
 * 探测异常时维持 'node' 旧行为(探测函数本身不 throw,此兜底只防测试桩异常)。
 */
async function resolveRunner(deps: HookScriptGeneratorDeps): Promise<'node' | 'xdt-node'> {
  try {
    const probe =
      deps.hasSystemNode ?? (await import('./hook-runtimes.js')).hasSystemNode;
    return (await probe()) ? 'node' : 'xdt-node';
  } catch {
    return 'node';
  }
}

/** 主编排:生成 → 提取 → 落盘 → 返回命令。失败 throw(IPC 层翻译成用户可见错误)。 */
export async function generateHookScript(
  deps: HookScriptGeneratorDeps,
  input: GenerateHookScriptInput,
): Promise<GenerateHookScriptResult> {
  // 懒加载:oneShotCandidates 的传递 import 链(runtime-configs → memory-settings-store)
  // 在模块顶层就读 electron app 路径,eager import 会让本模块在纯 node 测试环境
  // 无法加载(也违背"构造期不做 IO"的取向)。测试注入 requestText 时完全不触碰该链。
  if (!deps.maker && !deps.requestText) {
    throw new Error('hook script generation failed: maker not ready');
  }
  const requestText =
    deps.requestText ??
    (await import('../utility-model/oneShotCandidates.js')).requestUtilityText;

  // 修改流:解析旧脚本路径(相对命令按 workingDir 解析)并读入现有内容
  let reusePath: string | null = null;
  let currentScript: string | undefined;
  const parsed = parseGeneratedScriptPath(input.currentCommand);
  if (parsed) {
    const abs = path.isAbsolute(parsed)
      ? parsed
      : input.workingDir?.trim()
        ? path.resolve(input.workingDir, parsed)
        : null;
    if (abs && existsSync(abs)) {
      reusePath = abs;
      try {
        currentScript = readFileSync(abs, 'utf8').slice(0, CURRENT_SCRIPT_CAP);
      } catch {
        currentScript = undefined;
      }
    }
  }

  const prompt = buildHookScriptPrompt({
    description: input.description,
    platform: process.platform,
    scheduleName: input.scheduleName,
    workingDir: input.workingDir,
    currentScript,
  });

  const startedAt = Date.now();
  // 上方守卫保证:maker 为 null 时必有注入的 requestText(测试桩,不读 maker)
  const response = await requestText(deps.maker as Maker, prompt, {
    maxTokens: GENERATE_MAX_TOKENS,
    timeoutMs: GENERATE_TIMEOUT_MS,
    providerId: input.providerId,
    agentKind: input.agentKind,
    model: input.model,
  });
  if (!response.ok) throw new HookScriptUtilityModelError(response);
  const content = extractScriptFromResponse(response.text);
  if (!content) {
    throw new Error('hook script generation failed: response did not contain a code block');
  }

  const { filePath } = resolveHookScriptPath({
    workingDir: input.workingDir,
    fallbackDir: deps.fallbackDir,
    slug: hookScriptSlug(input.scheduleName, input.description),
    reusePath,
    exists: existsSync,
  });
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  // Persist an absolute path so a later session/workdir rebind cannot retarget the script.
  const command = buildHookCommand(filePath, undefined, await resolveRunner(deps));
  deps.logger?.info?.('[hook-script-generator] script written', {
    filePath,
    command,
    modified: !!reusePath,
    elapsedMs: Date.now() - startedAt,
  });
  return { command, filePath, content };
}

// ── 统一安装通道(UI「AI 生成」与 MCP schedule_set_pre_run_hook 共用)───────────

/** 自测与生产执行共用同一份 fail-closed 结果协议。 */
export type HookScriptSelfTest = PreRunHookRunResult;

export interface InstallHookScriptInput extends Omit<GenerateHookScriptInput, 'description'> {
  /** 自然语言需求;script 模式下可省略。 */
  description?: string;
  /**
   * agent 自己写好的脚本内容(Node ESM)。给了它就跳过 LLM 生成,代码只负责
   * 落盘路径规范/命令拼装/自测——聊天路径的 agent 有项目上下文,自己写的脚本
   * 通常更准;description 模式留给 UI「AI 生成」与不便写码的调用方。
   * script 与 description 至少给一个;都给时 script 优先。
   */
  script?: string;
}

export interface InstallHookScriptResult extends GenerateHookScriptResult {
  /** 落盘后立即执行一次的自测结果(exit code 协议验证由代码保证,不靠 agent 自觉)。 */
  test: HookScriptSelfTest;
}

/**
 * 统一安装:落盘(路径规范/命名/修改流复用)+ 立即自测。两条创建路径
 * (UI「AI 生成」按钮、MCP schedule_set_pre_run_hook)都走这里,协议与
 * 落盘规则只有一份实现。
 */
export async function installHookScript(
  deps: HookScriptGeneratorDeps,
  input: InstallHookScriptInput,
): Promise<InstallHookScriptResult> {
  let written: GenerateHookScriptResult;
  const script = input.script?.trim();
  if (script) {
    // script 模式:内容由调用方提供,代码只做确定性部分。
    const parsed = parseGeneratedScriptPath(input.currentCommand);
    let reusePath: string | null = null;
    if (parsed) {
      const abs = path.isAbsolute(parsed)
        ? parsed
        : input.workingDir?.trim()
          ? path.resolve(input.workingDir, parsed)
          : null;
      if (abs && existsSync(abs)) reusePath = abs;
    }
    const { filePath } = resolveHookScriptPath({
      workingDir: input.workingDir,
      fallbackDir: deps.fallbackDir,
      slug: hookScriptSlug(input.scheduleName, input.description),
      reusePath,
      exists: existsSync,
    });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, script.endsWith('\n') ? script : `${script}\n`, 'utf8');
    // script 模式内容同为 Node ESM(工具契约),执行方同样按探测结果选
    written = {
      // Persist an absolute path so a later session/workdir rebind cannot retarget the script.
      command: buildHookCommand(filePath, undefined, await resolveRunner(deps)),
      filePath,
      content: script,
    };
    deps.logger?.info?.('[hook-script-generator] agent-authored script installed', {
      filePath,
      command: written.command,
      modified: !!reusePath,
    });
  } else {
    const description = input.description?.trim();
    if (!description) {
      throw new Error('installHookScript: either script or description is required');
    }
    written = await generateHookScript(deps, { ...input, description });
  }

  // 落盘即自测:协议验证(exit code / 能否跑起来)由代码强制,不依赖调用方自觉。
  // 懒加载理由同 requestUtilityText(保持本模块纯 node 可测)。
  const { executePreRunHook } = await import('./pre-run-hook.js');
  const test = await executePreRunHook({
    command: written.command,
    // 定时触发路径未配置 timeoutMs = 不限时;但这里是同步等待结果的诊断自测,
    // 必须有界,否则脚本卡死会挂住整个 MCP / IPC 调用 —— 兜 30s 上限。
    timeoutMs: 30_000,
    cwd: input.workingDir,
    stdinPayload: {
      event: 'schedule-pre-run',
      scheduleId: 'self-test',
      scheduleName: input.scheduleName ?? 'self-test',
      runId: 'self-test',
      firedAt: Date.now(),
      workingDir: input.workingDir,
    },
  });
  return { ...written, test };
}
