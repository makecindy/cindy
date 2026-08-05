/**
 * generatedFiles — 从一轮回复的 tool_use 消息里派生「本轮 agent 新建的文件」。
 * ---------------------------------------------------------------------------
 * 纯派生、不新增持久化:tool_use 消息本身已落库并原样回放,所以历史会话重开后
 * 这张卡能稳定重建。跨 agent(claude-code / codex / pi)的工具名差异统一交给
 * `describeToolUse` 归一化,不自己维护工具名表:
 *   - kind==='file' 且 action==='create'  → Write / write(claude / pi 新建文件)
 *   - kind==='fileChange' 的 changes 里 action==='add' → codex file_change 新增文件
 *   - kind==='command' → 从命令文本启发式提取产物路径候选(source:'command')。
 *     Excel / Word / PDF 等二进制产物只能靠脚本(Bash/exec 跑 python、node)生成,
 *     没有文件工具记录;不补这个盲区,卡在「帮我生成个表格」主场景直接失灵。
 * 「修改已有文件」(edit / update)与读取不算产出(产品口径:只收新建,见
 * AskUserQuestion 决策)。move / delete 同样排除。
 *
 * 误报防线(source:'command' 特有,由渲染方 GeneratedFilesCard 执行):
 *   命令文本里出现路径 ≠ 命令创建了它(可能只是读输入)。所以 command 候选除
 *   存在性外,还必须满足「文件 mtime 落在本轮时间窗内」才出 chip;窗口不可得
 *   (消息无 createdAt / 远程会话无法 stat)时宁可不出。tool 来源保持原判定。
 */

import { describeToolUse } from '@cindy/maker-shared';

import { resolveToolFilePath } from './localPathResolver';
import { basename } from './utils';

export interface GeneratedFileRef {
  /** 已按 workingDir 解析的绝对路径(用于存在性校验与 chip 打开)。 */
  path: string;
  /** 展示用文件名(basename)。 */
  name: string;
  /**
   * 'tool' = 文件工具结构化新建记录,存在即列;
   * 'command' = 命令文本启发式候选,渲染前还需 mtime 时间窗校验。
   */
  source: 'tool' | 'command';
}

interface ToolUseLike {
  role: string;
  toolName?: string;
  toolInput?: unknown;
}

/**
 * 去重 key。**只对 Windows 路径形态**(盘符前缀或含反斜杠)做大小写不敏感折叠——
 * NTFS 上 `A.txt` 与 `a.txt` 是同一文件;POSIX 路径(Linux 本地会话 / 远程 Linux
 * workdir)必须保留原大小写,否则会把两个真实不同的文件错误合并、丢掉一个
 * (PR #1835 review)。macOS 虽默认大小写不敏感,但无法从纯 POSIX 路径形态区分
 * macOS 与 Linux;两害相权取轻:宁可 macOS 偶尔多出一个重复 chip,也不能在 Linux
 * 上丢文件。
 */
function dedupeKeyForPath(abs: string): string {
  const isWindowsShape = /^[a-zA-Z]:[\\/]/.test(abs) || abs.includes('\\');
  // 斜杠也归一:`C:/x/a.md`(命令文本常见形态)与 `C:\x\a.md`(Write 记录)是
  // 同一文件,不折叠会重复出 chip。
  return isWindowsShape ? abs.replace(/\//g, '\\').toLowerCase() : abs;
}

/**
 * Windows 形态的绝对路径统一成反斜杠本机形态再往下传:Explorer `/select`
 * (定位)对正斜杠路径静默无反应,`shell.openPath` 在仅用户层文件关联的机器上
 * 对正斜杠也会解析失败(实测「本轮产出」卡 docx chip 打不开的根因)。POSIX
 * 路径原样保留。
 */
function canonicalizeWindowsShape(abs: string): string {
  return /^[a-zA-Z]:[\\/]/.test(abs) ? abs.replace(/\//g, '\\') : abs;
}

/** 单条 tool_use 消息 → 它新建的文件原始路径列表(可能为空)。 */
function createdPathsFromToolUse(toolName: string, input: unknown): string[] {
  const descriptor = describeToolUse(toolName, input);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'create' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes
      .filter((c) => c.action === 'add' && c.path)
      .map((c) => c.path);
  }
  return [];
}

/** 带扩展名(1–8 位字母数字,不含纯数字)的路径才算候选;`a.b.c` 取末段。 */
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 临时目录里的产物是脚本自身/中间文件的高发区,一律不算「本轮产出」。 */
const TEMP_DIR_RE = /(^|[\\/])(tmp|temp)([\\/])|[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i;

function isPathCandidate(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3 || s.length > 512) return false;
  if (!EXT_RE.test(s)) return false;
  if (TEMP_DIR_RE.test(s)) return false;
  // 绝对路径,或含分隔符的相对路径(交给 resolveToolFilePath 按 workingDir 解析)。
  // 纯文件名(`输出.xlsx`)不收:随机带点 token 误报率太高。
  const isAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/');
  const hasSep = s.includes('/') || s.includes('\\');
  return isAbs || hasSep;
}

/**
 * 命令文本 → 产物路径候选。两个来源:
 *   1. 引号字符串(`'...'` / `"..."`):脚本内路径的主形态,可含空格与 CJK,
 *      如 python 的 `wb.save(r'C:\Users\x\表格.xlsx')`;
 *   2. 裸 token:重定向 / CLI 参数里的无引号绝对路径(不含空格)。
 * 只做形态过滤,不判断读写意图——读写区分交给渲染方的 mtime 时间窗。
 */
export function extractCommandPathCandidates(command: string): string[] {
  if (!command) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const s = raw.trim();
    if (!isPathCandidate(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const m of command.matchAll(/'([^'\r\n]+)'|"([^"\r\n]+)"/g)) {
    push(m[1] ?? m[2] ?? '');
  }
  // 裸 Windows 盘符路径与裸 POSIX 绝对路径(前面是行首/空白/常见分隔)。
  // 盘符前不允许字母数字:排除 URL scheme 尾字母被当盘符(https://…)。
  for (const m of command.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"<>|?*]+/g)) push(m[0]);
  for (const m of command.matchAll(/(?:^|[\s=(,>])(\/[^\s'"<>|?*:]+)/g)) push(m[1]);
  return out;
}

/**
 * 一组消息(通常是一个 turn 的切片,但对任意切片都成立)→ 新建文件的有序去重
 * 列表。路径经 `resolveToolFilePath` 解析成绝对路径;`workingDir` 为空时按原样
 * 保留(与其它 chip 解析同策)。存在性(及 command 候选的 mtime 时间窗)校验由
 * 调用方在渲染前做(异步 IPC)。同一路径同时有 tool 与 command 来源时按 tool 计
 * (tool 是结构化实锤,不该被降级成启发式候选)。
 */
export function collectGeneratedFiles(
  messages: readonly ToolUseLike[],
  workingDir: string,
): GeneratedFileRef[] {
  // 第一遍:收「本轮被文件工具**修改**过」的路径。它们是编辑不是新建,命令文本
  // 里再出现也不算产物候选——否则跑测试 / 构建命令引用刚编辑过的源码文件
  // (`vitest run src/x.test.ts`)会被 mtime 窗口放行,把编码会话的改动文件全
  // 误收进卡。read 不排除:agent 生成后回读验证是常见动作,不该反杀真产物。
  const editedKeys = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_use' || !msg.toolName) continue;
    const d = describeToolUse(msg.toolName, msg.toolInput);
    if (d.kind === 'file' && d.action === 'edit' && d.filePath) {
      editedKeys.add(dedupeKeyForPath(resolveToolFilePath(d.filePath, workingDir)));
    } else if (d.kind === 'fileChange') {
      for (const c of d.changes) {
        if (c.action !== 'add' && c.path) {
          editedKeys.add(dedupeKeyForPath(resolveToolFilePath(c.path, workingDir)));
        }
      }
    }
  }

  const byKey = new Map<string, GeneratedFileRef>();
  for (const msg of messages) {
    if (msg.role !== 'tool_use') continue;
    const toolName = msg.toolName ?? '';
    if (!toolName) continue;

    const addPath = (rawPath: string, source: GeneratedFileRef['source']): void => {
      const abs = canonicalizeWindowsShape(resolveToolFilePath(rawPath, workingDir));
      const key = dedupeKeyForPath(abs);
      if (source === 'command' && editedKeys.has(key)) return;
      const prev = byKey.get(key);
      if (prev) {
        if (prev.source === 'command' && source === 'tool') prev.source = 'tool';
        return;
      }
      byKey.set(key, { path: abs, name: basename(abs), source });
    };

    for (const rawPath of createdPathsFromToolUse(toolName, msg.toolInput)) {
      addPath(rawPath, 'tool');
    }
    const descriptor = describeToolUse(toolName, msg.toolInput);
    if (descriptor.kind === 'command' && descriptor.command) {
      for (const rawPath of extractCommandPathCandidates(descriptor.command)) {
        addPath(rawPath, 'command');
      }
    }
  }
  return [...byKey.values()];
}
