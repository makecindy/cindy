/**
 * Codex adapter-local detector for `functions.exec` yield.
 *
 * app-server 不暴露 cell 状态或 wait RPC。yield 的权威产物目前只活在工具输出文案里
 * （#3179 rollout: "Script running with cell ID 226"）。本模块把那条文案降格为
 * **检测启发式**：只用来铸造有界 continuation claim，不参与产品「是否交付完」判断。
 *
 * 协议级 executionHandle 是跨仓长期项；在那之前，漏判等于今天的假完成，误判只是
 * 多跑一轮有界续段。
 */

export interface YieldedExecCell {
  cellId: string;
  command?: string;
}

/**
 * Locked to the #3179 Codex rollout shape. Do not loosen without a new fixture.
 *
 * #3763 收紧:真实 yield 通知是执行器的**状态头**——marker 行从物理行首开始,
 * 且紧跟 `Wall time` 帧(同一行以空白分隔,或下一物理行)。被引用/示例出现的
 * 文案(grep 的 `路径:行号:` 前缀、源码里的缩进+引号、字面 `\n` 转义)都不满足
 * 这两条,不再被当成真实 cell 铸造 continuation claim —— 此前误判会让已成功的
 * 命令等待不存在的 cell,升级成 yield-continuation-lost-handle 终态失败。
 * 残余盲区:纯文本恰好在列 0 完整复刻两行状态头 —— 与真实执行器输出无法区分,
 * 接受(协议级 executionHandle 落地前的启发式边界)。
 */
export const YIELDED_EXEC_CELL_RE =
  /(?:^|\r?\n)Script running with cell ID[ \t]+(\d+)(?:[ \t]+|\r?\n)Wall time[ \t]/gi;

const MAX_SCAN_CHARS = 16_384;

export function extractYieldedExecCellIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const sample = textForScan(text);
  const ids: string[] = [];
  const seen = new Set<string>();
  YIELDED_EXEC_CELL_RE.lastIndex = 0;
  for (const match of sample.matchAll(YIELDED_EXEC_CELL_RE)) {
    const cellId = match[1];
    if (!cellId || seen.has(cellId)) continue;
    seen.add(cellId);
    ids.push(cellId);
  }
  return ids;
}

export function extractYieldedExecCellsFromCodexItem(item: unknown): YieldedExecCell[] {
  const record = asRecord(item);
  if (!record || !isApprovedYieldItem(record)) return [];
  const command = commandFromCodexItem(record);
  const ids = extractYieldedExecCellIds(collectItemText(record));
  return ids.map((cellId) => (
    command ? { cellId, command } : { cellId }
  ));
}

/**
 * Healthy Codex turns yield an exec cell, then call `wait` until that cell
 * finishes. The original exec item still contains the yield marker, so the
 * wait result is the only signal that the cell is no longer outstanding.
 */
export function extractSettledYieldCellIdsFromCodexItem(item: unknown): string[] {
  const record = asRecord(item);
  if (!record || !isWaitItem(record)) return [];
  const args = parseJsonObject(record.arguments) ?? asRecord(record.input);
  const cellId = firstString(args, ['cell_id', 'cellId']);
  if (!cellId) return [];
  const output = collectItemText(record);
  if (!WAIT_SETTLED_RE.test(output)) return [];
  if (extractYieldedExecCellIds(output).includes(cellId)) return [];
  return [cellId];
}

/**
 * A wait that still prints the running marker proves the claimed cell is alive.
 * The original exec item keeps the yield marker forever, so this is the only
 * evidence a later empty continuation can use to retry instead of lost-handle.
 */
export function extractAliveYieldCellsFromCodexItem(item: unknown): YieldedExecCell[] {
  const record = asRecord(item);
  if (!record || !isWaitItem(record)) return [];
  const args = parseJsonObject(record.arguments) ?? asRecord(record.input);
  const cellId = firstString(args, ['cell_id', 'cellId']);
  if (!cellId) return [];
  const output = collectItemText(record);
  if (!extractYieldedExecCellIds(output).includes(cellId)) return [];
  return [{ cellId }];
}

export function formatYieldContinuationPrompt(cells: readonly YieldedExecCell[]): string {
  const unique = dedupeCells(cells);
  const cellList = unique.map((cell) => {
    const command = cell.command?.trim();
    return command
      ? `- cell ID ${cell.cellId} (\`${truncateCommand(command)}\`)`
      : `- cell ID ${cell.cellId}`;
  }).join('\n');
  return [
    'A foreground exec cell is still running after the previous turn completed.',
    'Wait for every listed cell and finish the original user request. Do not start a new task.',
    'If a cell is gone, report that it was lost instead of rerunning the command.',
    unique.length === 1 ? `Wait for cell ID ${unique[0]!.cellId}.` : 'Wait for:',
    ...(unique.length > 1 ? [cellList] : []),
  ].join('\n');
}

const WAIT_SETTLED_RE = /Script (?:completed|terminated)/i;

function isApprovedYieldItem(record: Record<string, unknown>): boolean {
  if (record.type === 'commandExecution') return true;
  return record.type === 'function_call' && record.name === 'exec_command';
}

function isWaitItem(record: Record<string, unknown>): boolean {
  return record.type === 'function_call' && record.name === 'wait';
}

function textForScan(text: string): string {
  if (text.length <= MAX_SCAN_CHARS) return text;
  return `${text.slice(0, MAX_SCAN_CHARS)}\n${text.slice(-MAX_SCAN_CHARS)}`;
}

export function dedupeCells(cells: readonly YieldedExecCell[]): YieldedExecCell[] {
  const seen = new Set<string>();
  const out: YieldedExecCell[] = [];
  for (const cell of cells) {
    if (seen.has(cell.cellId)) continue;
    seen.add(cell.cellId);
    out.push(cell);
  }
  return out;
}

function truncateCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function commandFromCodexItem(record: Record<string, unknown>): string | undefined {
  if (typeof record.command === 'string' && record.command.trim()) return record.command;
  if (record.type === 'function_call' && record.name === 'exec_command') {
    const args = parseJsonObject(record.arguments);
    const command = firstString(args, ['cmd', 'command']);
    if (command) return command;
  }
  const nestedArgs = asRecord(record.arguments) ?? asRecord(record.input);
  return firstString(nestedArgs, ['cmd', 'command']);
}

function collectItemText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  pushText(parts, record.aggregatedOutput);
  pushText(parts, record.output);
  pushText(parts, record.result);
  pushText(parts, record.text);
  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      if (typeof entry === 'string') pushText(parts, entry);
      const nested = asRecord(entry);
      if (!nested) continue;
      pushText(parts, nested.text);
      pushText(parts, nested.output);
    }
  } else {
    pushText(parts, record.content);
  }
  if (Array.isArray(record.contentItems)) {
    for (const entry of record.contentItems) {
      const nested = asRecord(entry);
      if (!nested) continue;
      pushText(parts, nested.text);
    }
  }
  return parts.join('\n');
}

function pushText(parts: string[], value: unknown): void {
  if (typeof value === 'string' && value) parts.push(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function firstString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
