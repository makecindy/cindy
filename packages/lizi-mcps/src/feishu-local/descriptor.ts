import type { FeishuLocalReasonCode } from './types.js';

export const FEISHU_LOCAL_MIN_VERSION = '1.0.57';
export const FEISHU_LOCAL_VERSION_RANGE = '>=1.0.57 <2.0.0';
export const FEISHU_LOCAL_REQUIRED_SCOPES = ['sheets:spreadsheet', 'drive:drive'] as const;
export const FEISHU_LOCAL_CAPABILITIES = [
  'status',
  'read_cells',
  'set_cell_image',
  'clear_cells',
  'connect',
] as const;

/**
 * First-party trusted descriptor. The shape is deliberately the one a future
 * generic local-CLI framework can consume: publisher, version range, command
 * schemas, auth requirements and a signature slot. This first PR pins the
 * descriptor in built-in code; it does not discover binaries from PATH or
 * derive commands from `--help`.
 */
export const FEISHU_LOCAL_CLI_MANIFEST = {
  id: 'lark-cli',
  publisher: 'larksuite',
  versionRange: FEISHU_LOCAL_VERSION_RANGE,
  minSupportedVersion: FEISHU_LOCAL_MIN_VERSION,
  artifact: { binaryName: 'lark-cli', checksumAlgorithm: 'sha256', checksum: null },
  signature: {
    algorithm: 'ed25519',
    keyId: 'cindy-builtin-feishu-cli-v1',
    value: null,
    trust: 'builtin-pinned',
  },
  requiredScopes: [...FEISHU_LOCAL_REQUIRED_SCOPES],
  commands: {
    status: { argvTemplate: ['auth', 'status', '--json'], risk: 'read' },
    readCells: { argvTemplate: ['sheets', '+cells-get', '--format', 'json'], risk: 'read' },
    setCellImage: { argvTemplate: ['sheets', '+cells-set-image', '--format', 'json'], risk: 'write' },
    clearCells: { argvTemplate: ['sheets', '+cells-clear', '--format', 'json'], risk: 'high-risk-write' },
    connect: { argvTemplate: ['auth', 'login', '--domain', 'sheets,drive', '--no-wait', '--json'], risk: 'auth' },
  },
} as const;

export interface FeishuLocalSheetRef {
  sheet_id?: string;
  sheet_name?: string;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const value: unknown = JSON.parse(trimmed.slice(first, last + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function isVersionSupported(version: string | null): boolean {
  if (!version) return false;
  const match = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+\.\d+\.\d+)$/.exec(FEISHU_LOCAL_VERSION_RANGE);
  if (!match) return false;
  return compareSemver(version, match[1]) >= 0 && compareSemver(version, match[2]) < 0;
}

export function parseVersionOutput(stdout: string): string | null {
  const match = /(?:lark-cli version\s+)?(\d+\.\d+\.\d+)/i.exec(stdout);
  return match?.[1] ?? null;
}

export interface A1Bounds {
  firstRow: number | null;
  lastRow: number | null;
  firstColumn: number | null;
  lastColumn: number | null;
}

type A1Endpoint =
  | { kind: 'cell'; row: number; column: number }
  | { kind: 'column'; column: number }
  | { kind: 'row'; row: number };

function columnNumber(value: string): number | null {
  let column = 0;
  for (const letter of value.toUpperCase()) {
    const digit = letter.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26) return null;
    column = column * 26 + digit;
    if (!Number.isSafeInteger(column)) return null;
  }
  return column;
}

function positiveRow(value: string): number | null {
  const row = Number(value);
  return Number.isSafeInteger(row) && row > 0 ? row : null;
}

function parseA1Endpoint(value: string): A1Endpoint | null {
  const cell = /^([A-Za-z]+)(\d+)$/.exec(value);
  if (cell) {
    const column = columnNumber(cell[1]);
    const row = positiveRow(cell[2]);
    return column !== null && row !== null ? { kind: 'cell', row, column } : null;
  }
  if (/^[A-Za-z]+$/.test(value)) {
    const column = columnNumber(value);
    return column !== null ? { kind: 'column', column } : null;
  }
  if (/^\d+$/.test(value)) {
    const row = positiveRow(value);
    return row !== null ? { kind: 'row', row } : null;
  }
  return null;
}

export function parseA1Range(value: string): A1Bounds | null {
  const parts = value.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  const start = parseA1Endpoint(parts[0]);
  const end = parts.length === 2 ? parseA1Endpoint(parts[1]) : start;
  if (!start || !end || start.kind !== end.kind) return null;
  if (start.kind === 'cell' && end.kind === 'cell') {
    if (start.row > end.row || start.column > end.column) return null;
    return {
      firstRow: start.row,
      lastRow: end.row,
      firstColumn: start.column,
      lastColumn: end.column,
    };
  }
  if (start.kind === 'column' && end.kind === 'column') {
    if (start.column > end.column) return null;
    return { firstRow: null, lastRow: null, firstColumn: start.column, lastColumn: end.column };
  }
  if (start.kind === 'row' && end.kind === 'row') {
    if (start.row > end.row) return null;
    return { firstRow: start.row, lastRow: end.row, firstColumn: null, lastColumn: null };
  }
  return null;
}

export function parseA1Cell(value: string): A1Bounds | null {
  const bounds = parseA1Range(value);
  if (!bounds || bounds.firstRow === null || bounds.lastRow === null ||
      bounds.firstColumn === null || bounds.lastColumn === null ||
      bounds.firstRow !== bounds.lastRow || bounds.firstColumn !== bounds.lastColumn) return null;
  return bounds;
}

export function a1RangeCovers(outer: A1Bounds, inner: A1Bounds): boolean {
  const rowCovered = inner.firstRow === null || inner.lastRow === null
    ? outer.firstRow === null && outer.lastRow === null
    : outer.firstRow !== null && outer.lastRow !== null &&
      outer.firstRow <= inner.firstRow && outer.lastRow >= inner.lastRow;
  const columnCovered = inner.firstColumn === null || inner.lastColumn === null
    ? outer.firstColumn === null && outer.lastColumn === null
    : outer.firstColumn !== null && outer.lastColumn !== null &&
      outer.firstColumn <= inner.firstColumn && outer.lastColumn >= inner.lastColumn;
  return rowCovered && columnCovered;
}

export function isValidSingleCell(value: string): boolean {
  return parseA1Cell(value) !== null;
}

export function isValidA1Range(value: string): boolean {
  return parseA1Range(value) !== null;
}

const VERIFICATION_HOSTS = [
  'feishu.cn',
  'larksuite.com',
  'open.feishu.cn',
  'accounts.feishu.cn',
  'open.larksuite.com',
  'accounts.larksuite.com',
] as const;

export function isValidVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    if (!VERIFICATION_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) return false;
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (/token|secret|device|access|refresh/.test(lower)) return false;
      if (lower.includes('code') && lower !== 'user_code' && lower !== 'usercode') return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isValidImageRef(value: string): boolean {
  return /^(?:cindy-media:\/\/blobs\/[a-f0-9]{32,}\.[a-zA-Z0-9]+|xdt-image:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|bmp))$/i.test(value);
}

export function buildSpreadsheetArgs(spreadsheet: string): string[] {
  const isUrl = /^https?:\/\//i.test(spreadsheet) || spreadsheet.includes('://');
  return [isUrl ? '--url' : '--spreadsheet-token', spreadsheet];
}

export function buildSheetArgs(sheet: FeishuLocalSheetRef): string[] {
  if (sheet.sheet_id) return ['--sheet-id', sheet.sheet_id];
  if (sheet.sheet_name) return ['--sheet-name', sheet.sheet_name];
  return [];
}

export function buildReadCellsArgs(input: {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  range: string;
  include?: readonly string[];
}): string[] {
  return [
    ...FEISHU_LOCAL_CLI_MANIFEST.commands.readCells.argvTemplate,
    '--as', 'user',
    ...buildSpreadsheetArgs(input.spreadsheet),
    ...buildSheetArgs(input.sheet),
    '--range', input.range,
    ...(input.include?.length ? ['--include', input.include.join(',')] : []),
  ];
}

export function buildSetCellImageArgs(input: {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  cell: string;
  imagePath: string;
  displayName?: string;
  dryRun: boolean;
}): string[] {
  const name = input.displayName ?? input.imagePath.split(/[\\/]/).pop() ?? 'image';
  return [
    ...FEISHU_LOCAL_CLI_MANIFEST.commands.setCellImage.argvTemplate,
    '--as', 'user',
    ...buildSpreadsheetArgs(input.spreadsheet),
    ...buildSheetArgs(input.sheet),
    '--range', input.cell,
    '--image', input.imagePath,
    '--name', name,
    ...(input.dryRun ? ['--dry-run'] : []),
  ];
}

export function buildClearCellsArgs(input: {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  range: string;
  scope: 'content' | 'formats' | 'all';
  dryRun: boolean;
  confirmed: boolean;
}): string[] {
  return [
    ...FEISHU_LOCAL_CLI_MANIFEST.commands.clearCells.argvTemplate,
    '--as', 'user',
    ...buildSpreadsheetArgs(input.spreadsheet),
    ...buildSheetArgs(input.sheet),
    '--range', input.range,
    '--scope', input.scope,
    ...(input.dryRun ? ['--dry-run'] : []),
    ...(!input.dryRun && input.confirmed ? ['--yes'] : []),
  ];
}

export function parseCellValues(stdout: string): unknown[][] | null {
  const root = parseJsonObject(stdout);
  if (!root) return null;
  const candidates: unknown[] = [
    root.values,
    (root.data as Record<string, unknown> | undefined)?.values,
    ((root.data as Record<string, unknown> | undefined)?.valueRange as Record<string, unknown> | undefined)?.values,
    ((root.data as Record<string, unknown> | undefined)?.cell_ranges as unknown[] | undefined)?.[0],
    root.cell_ranges,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every(row => Array.isArray(row))) {
      return candidate as unknown[][];
    }
    if (candidate && typeof candidate === 'object') {
      const nested = (candidate as Record<string, unknown>).values;
      if (Array.isArray(nested) && nested.every(row => Array.isArray(row))) return nested as unknown[][];
    }
  }
  return null;
}

export function rowHash(values: unknown[][]): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(values);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

export function parseAuthStatus(stdout: string): {
  available: boolean;
  tokenStatus: string | null;
  scope: string | null;
  userName: string | null;
} {
  const root = parseJsonObject(stdout);
  const identities = (root?.identities as Record<string, unknown> | undefined) ?? {};
  const user = (identities.user as Record<string, unknown> | undefined) ?? {};
  return {
    available: user.available === true,
    tokenStatus: readString(user.tokenStatus),
    scope: readString(user.scope),
    userName: readString(user.userName),
  };
}

export function parseUpdateCheck(stdout: string): { current_version: string | null; latest_version: string | null } {
  const root = parseJsonObject(stdout);
  return {
    current_version: readString(root?.current_version) ?? readString(root?.previous_version),
    latest_version: readString(root?.latest_version),
  };
}

export function mapCliFailure(stdout: string, stderr: string, exitCode: number): {
  reasonCode: FeishuLocalReasonCode;
  message: string;
} {
  const payload = parseJsonObject(stdout) ?? parseJsonObject(stderr) ?? {};
  const error = readString(payload.error)?.toLowerCase() ?? '';
  const subtype = readString(payload.subtype)?.toLowerCase() ?? '';
  const message = readString(payload.message)?.toLowerCase() ?? '';
  const raw = `${error} ${subtype} ${message} ${stderr.toLowerCase()}`;
  if (raw.includes('permission') || raw.includes('scope') || raw.includes('app_scope_not_applied')) {
    return { reasonCode: 'SCOPE_MISSING', message: 'Feishu CLI reported a missing app or user scope.' };
  }
  if (raw.includes('unauthorized') || raw.includes('not authorized') || raw.includes('authentication') || raw.includes('expired')) {
    return { reasonCode: 'NOT_AUTHORIZED', message: 'Feishu CLI user authorization is missing or expired.' };
  }
  if (raw.includes('confirm') || exitCode === 10) {
    return { reasonCode: 'CONFIRMATION_REQUIRED', message: 'Feishu CLI requires an additional confirmation step.' };
  }
  if (raw.includes('path') || raw.includes('file') || raw.includes('image')) {
    return { reasonCode: 'PATH_HANDOFF_REJECTED', message: 'Feishu CLI rejected the handed-off image path.' };
  }
  return { reasonCode: 'CLI_FAILED', message: 'Feishu CLI command failed; raw output was withheld.' };
}

export function verifyBuiltInDescriptor(): boolean {
  const commands = FEISHU_LOCAL_CLI_MANIFEST.commands;
  return FEISHU_LOCAL_CLI_MANIFEST.id === 'lark-cli'
    && FEISHU_LOCAL_CLI_MANIFEST.signature.trust === 'builtin-pinned'
    && Object.keys(commands).length === FEISHU_LOCAL_CAPABILITIES.length - 1
    && commands.setCellImage.risk === 'write'
    && commands.clearCells.risk === 'high-risk-write';
}
