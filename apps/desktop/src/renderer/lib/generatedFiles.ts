/**
 * generatedFiles — 从一轮回复的 tool_use 消息里派生「本轮 agent 新建的文件」。
 * ---------------------------------------------------------------------------
 * 纯派生、不新增持久化:tool_use 消息本身已落库并原样回放,所以历史会话重开后
 * 这张卡能稳定重建。跨 agent(claude-code / codex / pi)的工具名差异统一交给
 * `describeToolUse` 归一化,不自己维护工具名表:
 *   - kind==='file' 且 action==='create'  → Write / write(claude / pi 新建文件)
 *   - kind==='fileChange' 的 changes 里 action==='add' → codex file_change 新增文件
 *   - kind==='command' → 从命令文本里带明确写出语义的位置提取产物路径候选(source:'command')。
 *     Excel / Word / PDF 等二进制产物只能靠脚本(Bash/exec 跑 python、node)生成,
 *     没有文件工具记录;不补这个盲区,卡在「帮我生成个表格」主场景直接失灵。
 * 「修改已有文件」(edit / update)与读取不算产出(产品口径:只收新建,见
 * AskUserQuestion 决策)。结构化文件工具的 move / delete 同样排除;命令层把明确的
 * copy / move 目标作为候选,用于临时文件落到最终产物路径的场景。
 *
 * 误报防线(source:'command' 特有,由渲染方 GeneratedFilesCard 执行):
 *   命令文本里出现路径 ≠ 命令创建了它(可能只是读输入)。所以只认重定向、save / write
 *   API、输出参数等明确写出位置;候选除存在性外,还必须满足「文件 mtime 落在本轮时间窗内」才出 chip;窗口不可得
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
  /** 文档工具返回的轻量交付信息；普通源码文件没有此字段。 */
  artifact?: DocumentArtifactMetadata;
  /** true 仅表示同一 tool_use 有结构化 ok:true 结果，可用本轮 mtime 证明成功覆盖。 */
  artifactConfirmed?: boolean;
}

export type DocumentArtifactFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
export type DocumentArtifactSummary = {
  kind: 'pages' | 'slides' | 'sheets' | 'rows' | 'bytes';
  value: number;
};

export type DocumentArtifactPreview =
  | {
      kind: 'sheet';
      /** 只取工具输入中真实存在的前几行、前几列。 */
      rows: string[][];
      hasHeader: boolean;
    }
  | {
      kind: 'slide';
      /** 封面文字来自第一张幻灯片，不构造示例内容。 */
      title?: string;
      subtitle?: string;
    };

export interface DocumentArtifactMetadata {
  format: DocumentArtifactFormat;
  title?: string;
  subtitle?: string;
  theme?: 'light' | 'dark' | 'navy';
  cover?: boolean;
  summary?: DocumentArtifactSummary;
  preview?: DocumentArtifactPreview;
}

interface ToolUseLike {
  role: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
}

function documentToolName(toolName: string): string | null {
  const normalized = toolName.replace(/^mcp__/, 'mcp:').replace(/__/g, ':');
  const name = normalized.split(':').at(-1) ?? normalized;
  return /^(make_docx|make_pptx|make_xlsx|render_pdf)$/.test(name) ? name : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseToolResult(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function previewCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, 48);
  }
  const record = asRecord(value);
  if (record && 'result' in record) return previewCellText(record.result);
  if (record && 'text' in record) return previewCellText(record.text);
  return '';
}

function sheetPreview(input: Record<string, unknown> | null): DocumentArtifactPreview | undefined {
  const firstSheet = asRecord(Array.isArray(input?.sheets) ? input.sheets[0] : null);
  if (!firstSheet) return undefined;
  const header = Array.isArray(firstSheet.header)
    ? firstSheet.header.slice(0, 3).map(previewCellText)
    : [];
  const bodyRows = Array.isArray(firstSheet.rows)
    ? firstSheet.rows
        .slice(0, header.length > 0 ? 3 : 4)
        .filter(Array.isArray)
        .map((row) => row.slice(0, 3).map(previewCellText))
    : [];
  const rows = header.length > 0 ? [header, ...bodyRows] : bodyRows;
  return rows.length > 0 ? { kind: 'sheet', rows, hasHeader: header.length > 0 } : undefined;
}

export function extractDocumentArtifactMetadata(
  toolName: string,
  input: unknown,
  resultContent?: string,
): DocumentArtifactMetadata | undefined {
  const name = documentToolName(toolName);
  if (!name) return undefined;
  const inputRecord = asRecord(input);
  const result = parseToolResult(resultContent);
  // 旧消息可能没有保存 tool_result，仍允许只按输入重建轻量卡片；但只要当前
  // 消息明确带了结果，就必须由 ok:true 证明生成成功。解析失败和 ok:false 都
  // 不能把同轮预先存在的同名文件冒充成这次成功交付的作品。
  if (resultContent !== undefined && result?.ok !== true) return undefined;
  const resultArtifact = asRecord(result?.artifact);
  const format =
    name === 'make_docx'
      ? 'docx'
      : name === 'make_pptx'
        ? 'pptx'
        : name === 'make_xlsx'
          ? 'xlsx'
          : 'pdf';
  const theme =
    stringField(resultArtifact, 'theme') ??
    stringField(result, 'theme') ??
    stringField(inputRecord, 'theme');
  const validTheme = theme === 'light' || theme === 'dark' || theme === 'navy' ? theme : undefined;
  const title =
    stringField(resultArtifact, 'title') ??
    stringField(result, 'title') ??
    stringField(inputRecord, 'title') ??
    (name === 'make_pptx'
      ? stringField(
          asRecord(Array.isArray(inputRecord?.slides) ? inputRecord.slides[0] : null),
          'title',
        )
      : name === 'make_xlsx'
        ? stringField(
            asRecord(Array.isArray(inputRecord?.sheets) ? inputRecord.sheets[0] : null),
            'name',
          )
        : undefined);
  const subtitle =
    stringField(resultArtifact, 'subtitle') ??
    stringField(result, 'subtitle') ??
    stringField(inputRecord, 'subtitle');
  const rawSummary = asRecord(resultArtifact?.summary) ?? asRecord(result?.summary);
  const summaryKind = rawSummary?.kind;
  const summaryValue = rawSummary?.value;
  const summary =
    (summaryKind === 'pages' ||
      summaryKind === 'slides' ||
      summaryKind === 'sheets' ||
      summaryKind === 'rows' ||
      summaryKind === 'bytes') &&
    typeof summaryValue === 'number' &&
    Number.isFinite(summaryValue)
      ? { kind: summaryKind, value: summaryValue }
      : name === 'make_pptx' && Array.isArray(inputRecord?.slides)
        ? { kind: 'slides' as const, value: inputRecord.slides.length }
        : name === 'make_xlsx' && Array.isArray(inputRecord?.sheets)
          ? { kind: 'sheets' as const, value: inputRecord.sheets.length }
          : (name === 'make_docx' || name === 'render_pdf') &&
              typeof result?.bytes === 'number' &&
              Number.isFinite(result.bytes)
            ? { kind: 'bytes' as const, value: result.bytes }
            : undefined;
  const firstSlide =
    name === 'make_pptx'
      ? asRecord(Array.isArray(inputRecord?.slides) ? inputRecord.slides[0] : null)
      : null;
  const preview =
    name === 'make_xlsx'
      ? sheetPreview(inputRecord)
      : name === 'make_pptx'
        ? {
            kind: 'slide' as const,
            ...(stringField(firstSlide, 'title')
              ? { title: stringField(firstSlide, 'title') }
              : {}),
            ...(stringField(firstSlide, 'subtitle')
              ? { subtitle: stringField(firstSlide, 'subtitle') }
              : {}),
          }
        : undefined;
  return {
    format,
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(validTheme ? { theme: validTheme } : {}),
    ...(typeof resultArtifact?.cover === 'boolean'
      ? { cover: resultArtifact.cover }
      : typeof inputRecord?.cover === 'boolean'
        ? { cover: inputRecord.cover }
        : {}),
    ...(summary ? { summary: summary as DocumentArtifactSummary } : {}),
    ...(preview ? { preview } : {}),
  };
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
  if (!isWindowsShape) return abs;
  // 斜杠也归一:`C:/x/a.md`(命令文本常见形态)与 `C:\x\a.md`(Write 记录)是
  // 同一文件,不折叠会重复出 chip。连续分隔符同理折叠:命令文本常是二次转义的
  // 包装串(如 powershell 包一层 node -e),提取出的 `C:\\x\\a.md` 与 `C:\x\a.md`
  // 在 fs 层等价(Windows 归并重复分隔符),不折叠会对同一文件出两个 chip。
  // UNC 头部的 `\\` 是路径语义的一部分,保留。
  return abs
    .replace(/\//g, '\\')
    .replace(/(?<!^)\\{2,}/g, '\\')
    .toLowerCase();
}

/**
 * Windows 形态的绝对路径统一成反斜杠本机形态再往下传:Explorer `/select`
 * (定位)对正斜杠路径静默无反应,`shell.openPath` 在仅用户层文件关联的机器上
 * 对正斜杠也会解析失败(实测「本轮产出」卡 docx chip 打不开的根因)。POSIX
 * 路径原样保留。
 */
function canonicalizeWindowsShape(abs: string): string {
  // 连续分隔符折叠进画布路径本身(不只 dedupe key):stat 虽能容忍 `C:\\x`,但
  // Explorer `/select` 与 chip 展示不该带转义残留。盘符形态不存在 UNC 头,可整段折叠。
  return /^[a-zA-Z]:[\\/]/.test(abs) ? abs.replace(/\//g, '\\').replace(/\\{2,}/g, '\\') : abs;
}

/** 单条 tool_use 消息 → 它新建的文件原始路径列表(可能为空)。 */
function createdPathsFromToolUse(toolName: string, input: unknown): string[] {
  const descriptor = describeToolUse(toolName, input);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'create' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes.filter((c) => c.action === 'add' && c.path).map((c) => c.path);
  }
  return [];
}

/** 文件候选需带扩展名;复制/移动命令的目录目标可用末尾分隔符明确表达。 */
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 临时目录里的产物是脚本自身/中间文件的高发区,一律不算「本轮产出」。 */
const TEMP_DIR_RE = /(^|[\\/])(tmp|temp)([\\/])|[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i;

function isPathCandidate(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3 || s.length > 512) return false;
  if (!EXT_RE.test(s) && !/[\\/]$/.test(s)) return false;
  if (TEMP_DIR_RE.test(s)) return false;
  // 绝对路径,或含分隔符的相对路径(交给 resolveToolFilePath 按 workingDir 解析)。
  // 纯文件名(`输出.xlsx`)不收:随机带点 token 误报率太高。
  const isAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/');
  const hasSep = s.includes('/') || s.includes('\\');
  return isAbs || hasSep;
}

interface CommandPathToken {
  path: string;
  start: number;
  end: number;
}

interface CommandArgument {
  value: string;
  start: number;
  end: number;
}

function extractCommandArguments(text: string, offset = 0): CommandArgument[] {
  const parsed = [...text.matchAll(/'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s]+)/g)].map((match) => {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const quoted = match[1] !== undefined || match[2] !== undefined;
    const quoteOffset = quoted ? 1 : 0;
    const start = offset + (match.index ?? 0) + quoteOffset;
    return { value, start, end: start + value.length, quoted };
  });
  const merged: typeof parsed = [];
  // POSIX shell 的奇数个尾随反斜杠会转义紧随其后的空白;只消费最后一个反斜杠,
  // 避免把 Windows 路径里的普通反斜杠做全局反转义。
  for (const argument of parsed) {
    const previous = merged.at(-1);
    const trailingBackslashes = previous?.value.match(/\\+$/)?.[0].length ?? 0;
    if (previous && !previous.quoted && !argument.quoted && trailingBackslashes % 2 === 1) {
      const gap = text.slice(previous.end - offset, argument.start - offset);
      if (/^[ \t]+$/.test(gap)) {
        previous.value = `${previous.value.slice(0, -1)}${gap[0]}${argument.value}`;
        previous.end = argument.end;
        continue;
      }
    }
    merged.push(argument);
  }
  return merged.map(({ value, start, end }) => ({ value, start, end }));
}

const RELATIVE_PATH_TOKEN_RE = /(?:^|[\s=(,>])([^\s'"<>|?*]+[\\/])(?=$|[\s'"<>|])/g;

/** 提取路径 token 及其在命令中的位置;写出语义需要靠相邻文本判断。 */
function extractCommandPathTokens(command: string): CommandPathToken[] {
  if (!command) return [];
  const out: CommandPathToken[] = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  const push = (raw: string, start: number, end: number): void => {
    const s = raw.trim();
    if (!isPathCandidate(s)) return;
    out.push({ path: s, start, end });
  };
  // 单、双引号分开扫描,才能识别 `node -e "save('C:\\out\\a.xlsx')"` 这类
  // 外层 shell 引号包内层语言字符串的常见形态。合并成一个 alternation 会被外层先吞掉。
  const scanQuoted = (re: RegExp): void => {
    for (const m of command.matchAll(re)) {
      const raw = m[1] ?? '';
      const matchStart = m.index ?? 0;
      quotedRanges.push({ start: matchStart, end: matchStart + m[0].length });
      push(raw, matchStart + 1, matchStart + 1 + raw.length);
    }
  };
  scanQuoted(/'([^'\r\n]+)'/g);
  scanQuoted(/"([^"\r\n]+)"/g);
  // 裸 Windows 盘符路径与裸 POSIX 绝对路径(前面是行首/空白/常见分隔)。
  // 盘符前不允许字母数字:排除 URL scheme 尾字母被当盘符(https://…)。
  const insideQuotedRange = (index: number): boolean =>
    quotedRanges.some((range) => index >= range.start && index < range.end);
  for (const m of command.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"<>|?*]+/g)) {
    const start = m.index ?? 0;
    if (!insideQuotedRange(start)) push(m[0], start, start + m[0].length);
  }
  for (const m of command.matchAll(/(?:^|[\s=(,>])(\/[^\s'"<>|?*:]+)/g)) {
    const start = (m.index ?? 0) + m[0].length - m[1].length;
    if (!insideQuotedRange(start)) push(m[1], start, start + m[1].length);
  }
  for (const m of command.matchAll(RELATIVE_PATH_TOKEN_RE)) {
    const raw = m[1];
    const start = (m.index ?? 0) + m[0].length - raw.length;
    if (!insideQuotedRange(start) && !/^https?:\/\//i.test(raw)) {
      push(raw, start, start + raw.length);
    }
  }
  for (const token of extractTransferPlainFilenameDestinations(command)) {
    out.push(token);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

const WRITE_CALL_PREFIX_RE =
  /(?:\.|\b)(?:save|savefig|writeFileSync|writeFile|writeAllText|writeAllBytes|createWriteStream|write_text|write_bytes|to_csv|to_excel|to_json|to_parquet|imwrite|imsave|dump)\s*\(\s*(?:(?:path_or_buf|excel_writer|path|filename|fname|fp|file)\s*=\s*)?(?:[rubf]{0,2})?['"]$/i;
const WRITE_CALL_LATER_KEYWORD_PREFIX_RE =
  /(?:\.|\b)(?:save|savefig|writeFileSync|writeFile|writeAllText|writeAllBytes|createWriteStream|write_text|write_bytes|to_csv|to_excel|to_json|to_parquet|imwrite|imsave|dump)\s*\(\s*[^();\r\n]+,\s*(?:path_or_buf|excel_writer|path|filename|fname|fp|file)\s*=\s*(?:[rubf]{0,2})?['"]$/i;
const OBJECT_FIRST_WRITE_CALL_PREFIX_RE =
  /\b(?:torch\.save|joblib\.dump)\s*\(\s*(?:[^();\r\n]|\([^()]*\))+,\s*(?:[rubf]{0,2})?['"]$/i;
const POWERSHELL_CMDLET_RE = /\b[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9-]*\b/g;
const POWERSHELL_WRITE_COMMANDS = new Set([
  'out-file',
  'set-content',
  'add-content',
  'export-csv',
  'export-clixml',
  'new-item',
]);
const OUTPUT_OPTION_PREFIX_RE =
  /(?:^|\s)(?:-o|--output(?:-file|-document)?|--outfile)(?:\s+|=)['"]?$/i;
const REDIRECT_PREFIX_RE = /(?:^|[^>])>{1,2}\s*['"]?$/;
const SAVE_COMMAND_PREFIX_RE = /(?:^|[;&|]\s*|\s)save\s+['"]?$/i;
const TEE_COMMAND_PREFIX_RE = /(?:^|[|;&]\s*)tee(?:\.exe)?\b[^|;&\r\n]*['"]?$/i;

function extractTransferPlainFilenameDestinations(command: string): CommandPathToken[] {
  const out: CommandPathToken[] = [];
  const commandRe =
    /\b(Copy-Item|Move-Item|copy|move|cp|mv)\b([^|;\r\n]*?)(?=\|{1,2}|;|\r?$|\n)/gim;
  for (const commandMatch of command.matchAll(commandRe)) {
    const commandName = (commandMatch[1] ?? '').toLowerCase();
    const argsText = commandMatch[2] ?? '';
    const argsStart = (commandMatch.index ?? 0) + commandMatch[0].length - argsText.length;
    const args = extractCommandArguments(argsText, argsStart);
    const isPlainFilename = (value: string): boolean =>
      EXT_RE.test(value) && !/[\\/<>|?*]/.test(value);
    if (commandName !== 'copy-item' && commandName !== 'move-item') {
      const supportsTargetDirectoryOption = commandName === 'cp' || commandName === 'mv';
      const targetDirectoryOptionIndex = supportsTargetDirectoryOption
        ? args.findIndex((arg) => /^(?:-t|--target-directory(?:=|$))/i.test(arg.value))
        : -1;
      if (targetDirectoryOptionIndex >= 0) {
        const option = args[targetDirectoryOptionIndex];
        const equalsIndex = option.value.indexOf('=');
        const separateDestination = args[targetDirectoryOptionIndex + 1];
        const rawDestination =
          equalsIndex >= 0 ? option.value.slice(equalsIndex + 1) : separateDestination?.value;
        const destinationStart =
          equalsIndex >= 0
            ? option.start + equalsIndex + 1
            : (separateDestination?.start ?? option.end);
        const destination = rawDestination?.replace(/^(['"])(.*)\1$/, '$2');
        if (destination && !TEMP_DIR_RE.test(destination) && !/[<>|?*]/.test(destination)) {
          out.push({
            path: /[\\/]$/.test(destination) ? destination : `${destination}/`,
            start: destinationStart,
            end: destinationStart + destination.length,
          });
        }
        continue;
      }
      const positional = args.filter(
        (arg) =>
          !arg.value.startsWith('-') &&
          !((commandName === 'copy' || commandName === 'move') && /^\/[A-Za-z]+$/.test(arg.value)),
      );
      const destination = positional.length >= 2 ? positional.at(-1) : undefined;
      if (destination && isPlainFilename(destination.value)) {
        out.push({ path: destination.value, start: destination.start, end: destination.end });
      }
      continue;
    }
    const explicitDestinationIndex = args.findIndex((arg) =>
      /^-(?:Destination|LiteralDestination|Target)$/i.test(arg.value),
    );
    if (explicitDestinationIndex >= 0) {
      const destination = args[explicitDestinationIndex + 1];
      if (destination && isPlainFilename(destination.value)) {
        out.push({ path: destination.value, start: destination.start, end: destination.end });
      }
      continue;
    }

    const positional: typeof args = [];
    let namedSource = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg.value.startsWith('-')) {
        positional.push(arg);
        continue;
      }
      if (/^-(?:Path|LiteralPath)$/i.test(arg.value)) namedSource = true;
      if (!/^-(?:Force|Recurse|PassThru|Container|Confirm|WhatIf)$/i.test(arg.value)) {
        index += 1;
      }
    }
    const destination = namedSource ? positional[0] : positional[1];
    if (destination && isPlainFilename(destination.value)) {
      out.push({ path: destination.value, start: destination.start, end: destination.end });
    }
  }
  return out;
}

function isTopLevelPowerShellTail(value: string): boolean {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '`') {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (char === ';' || char === '|' || char === '\r' || char === '\n')) {
      return false;
    }
  }
  return depth === 0;
}

function isPowerShellOutputPosition(before: string): boolean {
  const cmdlets = [...before.matchAll(POWERSHELL_CMDLET_RE)];
  const lastCmdlet = cmdlets.at(-1);
  const lastWriteCmdlet = cmdlets
    .filter((match) => POWERSHELL_WRITE_COMMANDS.has(match[0].toLowerCase()))
    .at(-1);
  if (!lastCmdlet || !lastWriteCmdlet) return false;
  const writeTail = before.slice((lastWriteCmdlet.index ?? 0) + lastWriteCmdlet[0].length);
  // Support the first positional path and the cmdlets' explicit path switches.
  // An explicit switch may follow a nested read expression, but it must remain at the writer's
  // top level so a nested `Get-Content -Path` cannot leak its input path.
  if (
    /-(?:FilePath|LiteralPath|Path)\s+['"]?$/i.test(writeTail) &&
    isTopLevelPowerShellTail(writeTail)
  ) {
    return true;
  }
  if (lastCmdlet.index !== lastWriteCmdlet.index) return false;
  const trailing = before.slice((lastCmdlet.index ?? 0) + lastCmdlet[0].length);
  return /^\s*['"]?$/.test(trailing);
}

function isExplicitOutputPath(
  command: string,
  token: CommandPathToken,
  tokens: readonly CommandPathToken[],
): boolean {
  const before = command.slice(Math.max(0, token.start - 240), token.start);
  const powerShellBefore = command.slice(0, token.start);
  const after = command.slice(token.end, token.end + 80);
  if (
    WRITE_CALL_PREFIX_RE.test(before) ||
    WRITE_CALL_LATER_KEYWORD_PREFIX_RE.test(before) ||
    OBJECT_FIRST_WRITE_CALL_PREFIX_RE.test(before) ||
    /^\s*['"]?\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/i.test(after) ||
    isPowerShellOutputPosition(powerShellBefore) ||
    OUTPUT_OPTION_PREFIX_RE.test(before) ||
    REDIRECT_PREFIX_RE.test(before) ||
    SAVE_COMMAND_PREFIX_RE.test(before) ||
    TEE_COMMAND_PREFIX_RE.test(before)
  ) {
    return true;
  }
  // Python / Ruby 等的 open(path, 'w'|'a'|'x'|'wb'...)。
  if (
    /\bopen\s*\(\s*(?:[rubf]{0,2})?['"]$/i.test(before) &&
    (/^['"]\s*,\s*['"][wax][bt+]*['"]/i.test(after) ||
      /^['"]\s*,\s*[^();\r\n]*\bmode\s*=\s*['"][wax][bt+]*['"]/i.test(after))
  ) {
    return true;
  }

  // copy/move 的最后一个路径参数是目标。只看当前命令段,避免把前一条命令的路径带进来。
  const previousSeparators = [
    { index: command.lastIndexOf(';', token.start - 1), length: 1 },
    { index: command.lastIndexOf('\n', token.start - 1), length: 1 },
    { index: command.lastIndexOf('&&', token.start - 1), length: 2 },
    { index: command.lastIndexOf('||', token.start - 1), length: 2 },
  ];
  const previousSeparator = previousSeparators.reduce((latest, candidate) =>
    candidate.index > latest.index ? candidate : latest,
  );
  const segmentStart = previousSeparator.index + previousSeparator.length;
  const nextSeparators = [
    command.indexOf(';', token.end),
    command.indexOf('\n', token.end),
    command.indexOf('&&', token.end),
    command.indexOf('||', token.end),
  ].filter((index) => index >= 0);
  const segmentEnd = nextSeparators.length > 0 ? Math.min(...nextSeparators) : command.length;
  const segment = command.slice(segmentStart, segmentEnd);
  const lastPath = tokens
    .filter((candidate) => candidate.start >= segmentStart && candidate.end <= segmentEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .at(-1);
  const beforeInSegment = command.slice(segmentStart, token.start);
  if (/(?:^|\|\s*)(?:Copy-Item|Move-Item)\b/i.test(segment.trim())) {
    const hasExplicitDestination = /-(?:Destination|LiteralDestination|Target)\s+/i.test(segment);
    if (hasExplicitDestination) {
      return /-(?:Destination|LiteralDestination|Target)\s+['"]?$/i.test(beforeInSegment);
    }
    return lastPath?.start === token.start && lastPath.end === token.end;
  }
  const isTargetDirectoryTransfer =
    /(?:^|\|\s*)(?:cp|mv)\s+/i.test(segment.trim()) &&
    /(?:^|\s)(?:-t(?:\s+|$)|--target-directory(?:\s+|=))/i.test(segment);
  if (isTargetDirectoryTransfer) {
    return /(?:^|\s)(?:-t|--target-directory)(?:\s+|=)['"]?$/i.test(beforeInSegment);
  }
  return (
    lastPath?.start === token.start &&
    lastPath.end === token.end &&
    /(?:^|\|\s*)(?:cp|copy|mv|move|Copy-Item|Move-Item)\s+/i.test(segment.trim())
  );
}

function transferDirectoryOutputs(
  command: string,
  destination: CommandPathToken,
  tokens: readonly CommandPathToken[],
): string[] {
  if (!/[\\/]$/.test(destination.path)) return [destination.path];
  const previousSeparators = [
    { index: command.lastIndexOf(';', destination.start - 1), length: 1 },
    { index: command.lastIndexOf('\n', destination.start - 1), length: 1 },
    { index: command.lastIndexOf('&&', destination.start - 1), length: 2 },
    { index: command.lastIndexOf('||', destination.start - 1), length: 2 },
  ];
  const previousSeparator = previousSeparators.reduce((latest, candidate) =>
    candidate.index > latest.index ? candidate : latest,
  );
  const segmentStart = previousSeparator.index + previousSeparator.length;
  const nextSeparators = [
    command.indexOf(';', destination.end),
    command.indexOf('\n', destination.end),
    command.indexOf('&&', destination.end),
    command.indexOf('||', destination.end),
  ].filter((index) => index >= 0);
  const segmentEnd = nextSeparators.length > 0 ? Math.min(...nextSeparators) : command.length;
  const sourcePaths = tokens
    .filter((token) => token.start >= segmentStart && token.end <= segmentEnd)
    .filter((token) => token.start !== destination.start)
    .filter((token) => !/[\\/]$/.test(token.path))
    .map((token) => token.path);
  const segmentArguments = extractCommandArguments(
    command.slice(segmentStart, segmentEnd),
    segmentStart,
  );
  for (const argument of segmentArguments) {
    if (argument.start === destination.start) continue;
    if (!EXT_RE.test(argument.value) || /[<>|?*]/.test(argument.value)) continue;
    if (!sourcePaths.includes(argument.value)) sourcePaths.push(argument.value);
  }
  const outputs = sourcePaths
    .map((source) => {
      const sourceName = source
        .replace(/[\\/]$/, '')
        .split(/[\\/]/)
        .at(-1);
      return sourceName ? `${destination.path}${sourceName}` : null;
    })
    .filter((path): path is string => Boolean(path));
  return outputs.length > 0 ? outputs : [destination.path];
}

/**
 * 命令文本 → 明确写出位置里的产物路径候选。
 *
 * mtime 只能证明文件最近变过,不能证明是当前命令创建的(新 worktree 中所有文件尤其容易
 * 同时命中时间窗)。因此普通参数、变量赋值、Get-Content / ReadAllLines 等读取位置一律不收;
 * 只认重定向、常见 save/write API、输出参数及复制/移动目标。后续仍由渲染方做时间窗复核。
 */
export function extractCommandOutputPathCandidates(command: string): string[] {
  const tokens = extractCommandPathTokens(command);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (!isExplicitOutputPath(command, token, tokens)) continue;
    for (const output of transferDirectoryOutputs(command, token, tokens)) {
      if (seen.has(output)) continue;
      seen.add(output);
      out.push(output);
    }
  }
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
  const resultByToolUseId = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role === 'tool_result' &&
      message.toolUseId &&
      typeof message.content === 'string'
    ) {
      resultByToolUseId.set(message.toolUseId, message.content);
    }
  }
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
    const resultContent = msg.toolUseId ? resultByToolUseId.get(msg.toolUseId) : undefined;
    const artifact = extractDocumentArtifactMetadata(toolName, msg.toolInput, resultContent);
    if (artifact) {
      const outputPath =
        typeof asRecord(msg.toolInput)?.outPath === 'string'
          ? (asRecord(msg.toolInput)!.outPath as string)
          : undefined;
      if (outputPath) {
        const abs = canonicalizeWindowsShape(resolveToolFilePath(outputPath, workingDir));
        const key = dedupeKeyForPath(abs);
        const existing = byKey.get(key);
        const artifactConfirmed = parseToolResult(resultContent)?.ok === true;
        if (existing) {
          existing.artifact = artifact;
          if (artifactConfirmed) existing.artifactConfirmed = true;
        } else {
          byKey.set(key, {
            path: abs,
            name: basename(abs),
            source: 'tool',
            artifact,
            ...(artifactConfirmed ? { artifactConfirmed: true } : {}),
          });
        }
      }
    }
    const descriptor = describeToolUse(toolName, msg.toolInput);
    if (descriptor.kind === 'command' && descriptor.command) {
      for (const rawPath of extractCommandOutputPathCandidates(descriptor.command)) {
        addPath(rawPath, 'command');
      }
    }
  }
  return [...byKey.values()];
}
