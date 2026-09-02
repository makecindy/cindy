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

import {
  createdPathsFromDescriptor,
  describeToolUse,
  sourcePathCandidatesFromDescriptor,
} from '@cindy/maker-shared';

import { extractCommandOutputPathCandidates } from '../../shared/commandOutputPaths';
import { resolveToolFilePath } from './localPathResolver';
import { basename } from './utils';

// 命令文本的写出语义判定搬到 `shared/commandOutputPaths`:仓库面板的主进程投影要
// 用同一套口径(否则「对话里有卡、仓库里没有」)。这里保留再导出,既有 import 点
// 与单测不受搬迁影响。
export { extractCommandOutputPathCandidates };

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
  /**
   * false = 创建它的 tool_use 还在跑(有 toolUseId、结果未到),文件多半没落盘。
   * 缺省 / true = 可以做存在性检查。历史消息没有 toolUseId 时按已完成处理。
   */
  ready?: boolean;
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

/**
 * 只认结构化失败：ok/success=false、status=error/failed，或 `<tool_use_error>`。
 * 普通 Write 失败文案不在这里猜，避免把成功输出误杀。
 */
export function isExplicitFailedToolResult(content: string | undefined): boolean {
  if (!content) return false;
  if (content.includes('<tool_use_error>')) return true;
  const parsed = parseToolResult(content);
  if (!parsed) return false;
  if (parsed.ok === false || parsed.success === false) return true;
  const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
  return status === 'error' || status === 'failed' || status === 'failure';
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

/** 单条 tool_use 消息 → 它新建的文件原始路径列表(可能为空)。判定在共享包里。 */
function createdPathsFromToolUse(toolName: string, input: unknown): string[] {
  return createdPathsFromDescriptor(describeToolUse(toolName, input));
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
    const resultContent = msg.toolUseId ? resultByToolUseId.get(msg.toolUseId) : undefined;
    if (msg.toolUseId && resultContent === undefined) continue;
    if (isExplicitFailedToolResult(resultContent)) continue;
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

    const resultContent = msg.toolUseId ? resultByToolUseId.get(msg.toolUseId) : undefined;
    const toolFailed = isExplicitFailedToolResult(resultContent);
    const toolReady = !msg.toolUseId || resultByToolUseId.has(msg.toolUseId);
    const addPath = (rawPath: string, source: GeneratedFileRef['source']): void => {
      if (toolFailed) return;
      const abs = canonicalizeWindowsShape(resolveToolFilePath(rawPath, workingDir));
      const key = dedupeKeyForPath(abs);
      if (source === 'command' && editedKeys.has(key)) return;
      const prev = byKey.get(key);
      if (prev) {
        if (prev.source === 'command' && source === 'tool') prev.source = 'tool';
        if (toolReady) delete prev.ready;
        return;
      }
      byKey.set(key, {
        path: abs,
        name: basename(abs),
        source,
        ...(toolReady ? {} : { ready: false }),
      });
    };

    for (const rawPath of createdPathsFromToolUse(toolName, msg.toolInput)) {
      addPath(rawPath, 'tool');
    }
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
          // 同路径第二次文档工具还在跑时，保留第一次已确认的交付，不要用未落地预览覆盖。
          if (!toolReady || toolFailed) {
            /* keep existing */
          } else {
            existing.artifact = artifact;
            if (artifactConfirmed) existing.artifactConfirmed = true;
            delete existing.ready;
          }
        } else {
          byKey.set(key, {
            path: abs,
            name: basename(abs),
            source: 'tool',
            artifact,
            ...(artifactConfirmed ? { artifactConfirmed: true } : {}),
            ...(toolReady ? {} : { ready: false }),
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
    if (descriptor.kind === 'fileChange' && toolReady && !toolFailed) {
      for (const change of descriptor.changes) {
        if ((change.action === 'delete' || change.action === 'move') && change.path) {
          byKey.delete(dedupeKeyForPath(resolveToolFilePath(change.path, workingDir)));
        }
      }
    }
  }

  // 最后一遍:摘掉中间件 —— 本轮产出、但又被本轮另一次产出当素材读走的文件。
  // 典型是自己写的 HTML 设计稿:它先被 Write 出来,再被 render_pdf 渲成 PDF,
  // 两个都进列表的话用户会同时看到设计稿和成品(2026-08-21 实测)。
  // 求交集而不是猜字段名,所以只有真产出过的文件才可能被摘。
  for (const msg of messages) {
    if (msg.role !== 'tool_use' || !msg.toolName) continue;
    const d = describeToolUse(msg.toolName, msg.toolInput);
    for (const raw of sourcePathCandidatesFromDescriptor(d)) {
      byKey.delete(dedupeKeyForPath(canonicalizeWindowsShape(resolveToolFilePath(raw, workingDir))));
    }
  }
  return [...byKey.values()];
}
