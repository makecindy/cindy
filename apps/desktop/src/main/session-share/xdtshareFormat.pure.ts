/**
 * 会话分享文件(.cshare,旧名 .xdtshare)的外层封装格式与 manifest 契约(纯函数,零 IO)。
 *
 * 文件 = 固定二进制头 + payload(内层 zip,可选加密):
 *
 *   偏移  长度  内容
 *   0     8    magic: ASCII "XDTSHARE"
 *   8     1    headerVersion: u8(仅头结构变化时 bump)
 *   9     1    cipher: u8 — 0 = 明文, 1 = scrypt + AES-256-GCM
 *   10    2    reserved(0)
 *   —— cipher=1 时追加 ——
 *   12    1    logN(scrypt N = 2^logN)
 *   13    1    r
 *   14    1    p
 *   15    1    reserved(0)
 *   16    16   salt
 *   32    12   IV
 *   44    16   GCM authTag
 *   60    ...  ciphertext
 *   —— cipher=0 时 ——
 *   12    ...  zip bytes 原样
 *
 * 加密时头部前 44 字节(magic..IV)作为 GCM AAD,防止头字段(尤其 cipher 标志与
 * KDF 参数)被离线篡改。KDF 参数写进头里而非代码写死,未来调参不 break 旧文件。
 *
 * 版本策略:
 * - headerVersion 只管外层头结构;
 * - manifest.formatVersion / minReaderVersion 管内层语义,additive 字段不 bump,
 *   破坏性变更同时 bump 两者,导入端按 minReaderVersion 门禁拒读。
 */

/**
 * 对外文件扩展名。2026-07 起导出用 .cshare;旧 .xdtshare 文件内容格式完全相同,
 * 导入侧永久兼容。⚠️ 二进制魔数仍是 "XDTSHARE"(内容层格式标识,与扩展名无关),
 * 改魔数会 break 所有已导出文件,不要动。
 */
export const SHARE_FILE_EXT = '.cshare';
export const LEGACY_SHARE_FILE_EXT = '.xdtshare';
export const SHARE_FILE_EXTENSIONS = [SHARE_FILE_EXT, LEGACY_SHARE_FILE_EXT] as const;

export const XDTSHARE_MAGIC = 'XDTSHARE';
export const XDTSHARE_HEADER_VERSION = 1;
export const XDTSHARE_FORMAT_VERSION = 1;
export const XDTSHARE_MIN_READER_VERSION = 1;
/** 本端能读的最高 minReaderVersion(导入端门禁比较对象)。 */
export const XDTSHARE_READER_VERSION = 1;

export const XDTSHARE_PLAIN_HEADER_LENGTH = 12;
export const XDTSHARE_ENCRYPTED_HEADER_LENGTH = 60;
/** AAD = 头部 [0, 44):magic + 版本 + cipher + KDF 参数 + salt + IV(不含 authTag)。 */
export const XDTSHARE_AAD_LENGTH = 44;

export const XDTSHARE_SALT_LENGTH = 16;
export const XDTSHARE_IV_LENGTH = 12;
export const XDTSHARE_AUTH_TAG_LENGTH = 16;

/** 导出端当前使用的 scrypt 参数(解码端一律以头内值为准,不读这些常量)。 */
export const XDTSHARE_SCRYPT_LOG_N = 15;
export const XDTSHARE_SCRYPT_R = 8;
export const XDTSHARE_SCRYPT_P = 1;

/** zip local file header magic,解密/明文 payload 的最终合法性检查。 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export type XdtshareErrorCode =
  | 'SHARE_FILE_INVALID'
  | 'SHARE_PASSWORD_REQUIRED'
  | 'SHARE_PASSWORD_WRONG'
  | 'SHARE_VERSION_UNSUPPORTED';

/** 带 code 的格式层错误;IPC handler 层直接映射到 throwIpcError 同名 code。 */
export class XdtshareError extends Error {
  readonly code: XdtshareErrorCode;

  constructor(code: XdtshareErrorCode, message: string) {
    super(message);
    this.name = 'XdtshareError';
    this.code = code;
  }
}

export interface XdtsharePlainHeader {
  cipher: 0;
  payloadOffset: number;
}

export interface XdtshareEncryptedHeader {
  cipher: 1;
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** AAD 原文(头部前 44 字节),解密侧直接复用避免重拼。 */
  aad: Buffer;
  payloadOffset: number;
}

export type XdtshareHeader = XdtsharePlainHeader | XdtshareEncryptedHeader;

/** 编码明文文件头(12 字节)。 */
export function encodePlainHeader(): Buffer {
  const header = Buffer.alloc(XDTSHARE_PLAIN_HEADER_LENGTH);
  header.write(XDTSHARE_MAGIC, 0, 'ascii');
  header.writeUInt8(XDTSHARE_HEADER_VERSION, 8);
  header.writeUInt8(0, 9);
  return header;
}

/**
 * 编码加密文件头(60 字节)。authTag 由调用方在完成 GCM 加密后回写
 * (加密必须先有 AAD,而 AAD 是头部前 44 字节,故 tag 只能后置 patch)。
 */
export function encodeEncryptedHeader(params: {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  iv: Buffer;
}): Buffer {
  if (params.salt.length !== XDTSHARE_SALT_LENGTH) {
    throw new XdtshareError('SHARE_FILE_INVALID', `salt must be ${XDTSHARE_SALT_LENGTH} bytes`);
  }
  if (params.iv.length !== XDTSHARE_IV_LENGTH) {
    throw new XdtshareError('SHARE_FILE_INVALID', `iv must be ${XDTSHARE_IV_LENGTH} bytes`);
  }
  const header = Buffer.alloc(XDTSHARE_ENCRYPTED_HEADER_LENGTH);
  header.write(XDTSHARE_MAGIC, 0, 'ascii');
  header.writeUInt8(XDTSHARE_HEADER_VERSION, 8);
  header.writeUInt8(1, 9);
  header.writeUInt8(params.logN, 12);
  header.writeUInt8(params.r, 13);
  header.writeUInt8(params.p, 14);
  params.salt.copy(header, 16);
  params.iv.copy(header, 32);
  // authTag [44, 60) 留零,加密完成后由 sealPayload patch。
  return header;
}

/** 解析文件头。非本格式 / 头损坏 → SHARE_FILE_INVALID;头版本过新 → SHARE_VERSION_UNSUPPORTED。 */
export function decodeXdtshareHeader(file: Buffer): XdtshareHeader {
  if (file.length < XDTSHARE_PLAIN_HEADER_LENGTH) {
    throw new XdtshareError('SHARE_FILE_INVALID', 'file too short for xdtshare header');
  }
  if (file.toString('ascii', 0, 8) !== XDTSHARE_MAGIC) {
    throw new XdtshareError('SHARE_FILE_INVALID', 'bad magic: not a .cshare/.xdtshare share file');
  }
  const headerVersion = file.readUInt8(8);
  if (headerVersion > XDTSHARE_HEADER_VERSION) {
    throw new XdtshareError(
      'SHARE_VERSION_UNSUPPORTED',
      `header version ${headerVersion} is newer than supported ${XDTSHARE_HEADER_VERSION}`,
    );
  }
  const cipher = file.readUInt8(9);
  if (cipher === 0) {
    return { cipher: 0, payloadOffset: XDTSHARE_PLAIN_HEADER_LENGTH };
  }
  if (cipher !== 1) {
    throw new XdtshareError('SHARE_FILE_INVALID', `unknown cipher byte: ${cipher}`);
  }
  if (file.length < XDTSHARE_ENCRYPTED_HEADER_LENGTH) {
    throw new XdtshareError('SHARE_FILE_INVALID', 'file too short for encrypted header');
  }
  const logN = file.readUInt8(12);
  const r = file.readUInt8(13);
  const p = file.readUInt8(14);
  // 上界防御:恶意头把 KDF 参数拉满会造成解密端内存/CPU 放大(logN=31 → 128GB)。
  if (logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 4) {
    throw new XdtshareError('SHARE_FILE_INVALID', `scrypt params out of range: N=2^${logN} r=${r} p=${p}`);
  }
  return {
    cipher: 1,
    logN,
    r,
    p,
    salt: Buffer.from(file.subarray(16, 32)),
    iv: Buffer.from(file.subarray(32, 44)),
    authTag: Buffer.from(file.subarray(44, 60)),
    aad: Buffer.from(file.subarray(0, XDTSHARE_AAD_LENGTH)),
    payloadOffset: XDTSHARE_ENCRYPTED_HEADER_LENGTH,
  };
}

/** payload(明文或解密后)是否是合法 zip 开头。 */
export function looksLikeZip(payload: Buffer): boolean {
  return payload.length >= 4 && payload.subarray(0, 4).equals(ZIP_MAGIC);
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export type XdtshareFidelity = 'full' | 'partial' | 'db-only';

export interface XdtshareManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface XdtshareTranscriptRef {
  sdkSessionId: string;
  /** zip 内路径;null = 导出端就没找到这份转录。 */
  path: string | null;
}

export interface XdtshareManifest {
  formatVersion: number;
  minReaderVersion: number;
  appVersion: string;
  platform: string;
  exportedAt: string;
  agentKind: 'cc' | 'codex';
  title: string;
  workspaceKind: 'project' | 'dialogue';
  originalWorkingDir: string | null;
  /** fork/rewind 链上的全部 sdk session id(cc);codex 为 [threadId]。 */
  sdkSessionIds: string[];
  /** sessions.sdk_session_id,resume 实际使用的那个。 */
  activeSdkSessionId: string | null;
  exportFidelity: XdtshareFidelity;
  counts: { messages: number; media: number };
  entries: XdtshareManifestEntry[];
  transcripts: XdtshareTranscriptRef[];
}

const FIDELITIES: ReadonlySet<string> = new Set(['full', 'partial', 'db-only']);
const AGENT_KINDS: ReadonlySet<string> = new Set(['cc', 'codex']);
const WORKSPACE_KINDS: ReadonlySet<string> = new Set(['project', 'dialogue']);

/**
 * 校验解包出的 manifest。字段级损坏 → SHARE_FILE_INVALID;
 * minReaderVersion 超过本端 → SHARE_VERSION_UNSUPPORTED。
 * 未知的多余字段一律忽略(additive 前向兼容)。
 */
export function validateManifest(value: unknown): XdtshareManifest {
  if (!isRecord(value)) throw invalid('manifest must be an object');
  const formatVersion = expectPositiveInt(value.formatVersion, 'formatVersion');
  const minReaderVersion = expectPositiveInt(value.minReaderVersion, 'minReaderVersion');
  if (minReaderVersion > XDTSHARE_READER_VERSION) {
    throw new XdtshareError(
      'SHARE_VERSION_UNSUPPORTED',
      `bundle requires reader version ${minReaderVersion}, this app supports ${XDTSHARE_READER_VERSION}`,
    );
  }
  const agentKind = expectString(value.agentKind, 'agentKind');
  if (!AGENT_KINDS.has(agentKind)) throw invalid(`unknown agentKind: ${agentKind}`);
  const workspaceKind = expectString(value.workspaceKind, 'workspaceKind');
  if (!WORKSPACE_KINDS.has(workspaceKind)) throw invalid(`unknown workspaceKind: ${workspaceKind}`);
  const exportFidelity = expectString(value.exportFidelity, 'exportFidelity');
  if (!FIDELITIES.has(exportFidelity)) throw invalid(`unknown exportFidelity: ${exportFidelity}`);

  const counts = isRecord(value.counts) ? value.counts : {};
  const entries = expectArray(value.entries, 'entries').map((raw, i) => {
    if (!isRecord(raw)) throw invalid(`entries[${i}] must be an object`);
    return {
      path: expectString(raw.path, `entries[${i}].path`),
      bytes: expectNonNegativeInt(raw.bytes, `entries[${i}].bytes`),
      sha256: expectString(raw.sha256, `entries[${i}].sha256`),
    };
  });
  const transcripts = expectArray(value.transcripts, 'transcripts').map((raw, i) => {
    if (!isRecord(raw)) throw invalid(`transcripts[${i}] must be an object`);
    return {
      sdkSessionId: expectString(raw.sdkSessionId, `transcripts[${i}].sdkSessionId`),
      path: raw.path == null ? null : expectString(raw.path, `transcripts[${i}].path`),
    };
  });

  return {
    formatVersion,
    minReaderVersion,
    appVersion: expectString(value.appVersion, 'appVersion'),
    platform: expectString(value.platform, 'platform'),
    exportedAt: expectString(value.exportedAt, 'exportedAt'),
    agentKind: agentKind as 'cc' | 'codex',
    title: expectString(value.title, 'title'),
    workspaceKind: workspaceKind as 'project' | 'dialogue',
    originalWorkingDir:
      value.originalWorkingDir == null
        ? null
        : expectString(value.originalWorkingDir, 'originalWorkingDir'),
    sdkSessionIds: expectArray(value.sdkSessionIds, 'sdkSessionIds').map((id, i) =>
      expectString(id, `sdkSessionIds[${i}]`),
    ),
    activeSdkSessionId:
      value.activeSdkSessionId == null
        ? null
        : expectString(value.activeSdkSessionId, 'activeSdkSessionId'),
    exportFidelity: exportFidelity as XdtshareFidelity,
    counts: {
      messages: expectNonNegativeInt(counts.messages ?? 0, 'counts.messages'),
      media: expectNonNegativeInt(counts.media ?? 0, 'counts.media'),
    },
    entries,
    transcripts,
  };
}

function invalid(message: string): XdtshareError {
  return new XdtshareError('SHARE_FILE_INVALID', `manifest: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} must be a string`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value;
}

function expectPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive integer`);
  }
  return value;
}

function expectNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative integer`);
  }
  return value;
}
