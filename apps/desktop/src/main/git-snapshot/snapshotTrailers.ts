/**
 * git-snapshot: 保存点元数据 ⇄ commit message 的序列化/解析。
 *
 * 设计取舍(见产品设计稿《事实源选择》): git history 是保存点的唯一事实源,
 * 不另起 SQLite 表。每个保存点把受控元数据用 git 原生 trailer
 * (commit message 末尾的 `Key: value` 脚注)写进 commit, 时间线 = 解析 git log。
 *
 * 纯函数, 无 IO。trailer 私有前缀 X-XDT-* 保证不和用户自己的 commit 混淆,
 * 非保存点 commit 一律 parse 成 null(时间线只认我们建的点)。
 */

/** 保存点 / rollback 提交的受控来源。 */
const SNAPSHOT_KIND_VALUES = [
  'before-edit',
  'after-edit',
  'manual',
  'pre-rollback',
  'rewind-blocked',
  'rollback',
  'rollback-undo',
] as const;

export type SnapshotKind = typeof SNAPSHOT_KIND_VALUES[number];

const VALID_KINDS: ReadonlySet<string> = new Set(SNAPSHOT_KIND_VALUES);

/** 写入 commit 的绑定元数据。 */
export interface SnapshotMeta {
  /** 创建该保存点 / rollback 提交的会话 id。 */
  sessionId: string;
  kind: SnapshotKind;
  /** 绑定的对话消息锚点(message clientId), 可空。 */
  anchor?: string;
  /** 一次 rollback / undo 的稳定 id。 */
  rollbackId?: string;
  /** rollback 入口: commit hash 或 message clientId。 */
  rollbackTarget?: string;
  /** 本次 rollback 撤销的原始 commit, 按执行顺序记录。 */
  reverts?: string[];
  /** 回退前保护 ref, 用于审计或灾难恢复。 */
  protectRef?: string;
  /** 创建保存点时所在分支, 后续用于隔离时间线。 */
  branch?: string;
}

/** 从 commit message 解析回来的保存点。 */
export interface ParsedSnapshot extends SnapshotMeta {
  /** commit message 的正文(trailer 之前的部分), 即时间线展示名。 */
  label: string;
}

const TRAILER_SESSION = 'X-XDT-Session';
const TRAILER_KIND = 'X-XDT-Kind';
const TRAILER_ANCHOR = 'X-XDT-Anchor';
const TRAILER_ROLLBACK_ID = 'X-XDT-RollbackId';
const TRAILER_ROLLBACK_TARGET = 'X-XDT-RollbackTarget';
const TRAILER_REVERTS = 'X-XDT-Reverts';
const TRAILER_PROTECT_REF = 'X-XDT-ProtectRef';
const TRAILER_BRANCH = 'X-XDT-Branch';

/** 一行 XDT trailer 的匹配: `X-XDT-Xxx: value`。 */
const XDT_TRAILER_RE = /^X-XDT-[A-Za-z0-9]+:\s?(.*)$/;

/** 一行 git trailer 的粗匹配, 用于识别混合 trailer block 的边界。 */
const GIT_TRAILER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*:\s?.*$/;

/** git trailer 允许用空白前缀行折叠长 value。 */
const GIT_TRAILER_CONTINUATION_RE = /^[ \t].*$/;

function unfoldTrailerLines(lines: readonly string[]): string[] {
  const unfolded: string[] = [];
  for (const line of lines) {
    if (GIT_TRAILER_CONTINUATION_RE.test(line)) {
      if (unfolded.length > 0) {
        unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
      }
      continue;
    }
    unfolded.push(line);
  }
  return unfolded;
}

/**
 * 组装 commit message: 正文 label + 空行 + X-XDT-* trailer 块。
 * anchor 缺省时不产生空 trailer 行。
 */
export function buildCommitMessage(label: string, meta: SnapshotMeta): string {
  const trailers: string[] = [
    `${TRAILER_SESSION}: ${meta.sessionId}`,
    `${TRAILER_KIND}: ${meta.kind}`,
  ];
  if (meta.anchor) {
    trailers.push(`${TRAILER_ANCHOR}: ${meta.anchor}`);
  }
  if (meta.rollbackId) {
    trailers.push(`${TRAILER_ROLLBACK_ID}: ${meta.rollbackId}`);
  }
  if (meta.rollbackTarget) {
    trailers.push(`${TRAILER_ROLLBACK_TARGET}: ${meta.rollbackTarget}`);
  }
  if (meta.reverts?.length) {
    trailers.push(`${TRAILER_REVERTS}: ${meta.reverts.join(',')}`);
  }
  if (meta.protectRef) {
    trailers.push(`${TRAILER_PROTECT_REF}: ${meta.protectRef}`);
  }
  if (meta.branch) {
    trailers.push(`${TRAILER_BRANCH}: ${meta.branch}`);
  }
  return `${label}\n\n${trailers.join('\n')}`;
}

/**
 * 解析 commit message(通常来自 git log %B)。
 *
 * 策略: 从末尾向上收集"连续的 git trailer 行"作为 trailer 块, 再筛 X-XDT-*。
 * 因为 label 行不会以 `X-XDT-` 开头, 即使 label 含冒号/换行也不会误判。
 * 缺 Session / 缺 Kind / Kind 非法 → 返回 null(不是合法保存点)。
 */
export function parseSnapshotCommit(rawMessage: string): ParsedSnapshot | null {
  // 去掉 git %B 常见的末尾多余换行, 再按行拆。
  const lines = rawMessage.replace(/\s+$/, '').split('\n');

  // 从末尾向上吃连续的 git trailer 行, 兼容 Signed-off-by / Change-Id 等混合和折叠 trailer。
  let i = lines.length - 1;
  const trailerLines: string[] = [];
  while (i >= 0 && (GIT_TRAILER_RE.test(lines[i]) || GIT_TRAILER_CONTINUATION_RE.test(lines[i]))) {
    trailerLines.unshift(lines[i]);
    i -= 1;
  }
  if (trailerLines.length === 0) return null;

  let sessionId: string | undefined;
  let kind: string | undefined;
  let anchor: string | undefined;
  let rollbackId: string | undefined;
  let rollbackTarget: string | undefined;
  let reverts: string[] | undefined;
  let protectRef: string | undefined;
  let branch: string | undefined;
  for (const line of unfoldTrailerLines(trailerLines)) {
    if (!XDT_TRAILER_RE.test(line)) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    if (key === TRAILER_SESSION) sessionId = value;
    else if (key === TRAILER_KIND) kind = value;
    else if (key === TRAILER_ANCHOR) anchor = value;
    else if (key === TRAILER_ROLLBACK_ID) rollbackId = value;
    else if (key === TRAILER_ROLLBACK_TARGET) rollbackTarget = value;
    else if (key === TRAILER_REVERTS) {
      reverts = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key === TRAILER_PROTECT_REF) protectRef = value;
    else if (key === TRAILER_BRANCH) branch = value;
  }

  if (!sessionId || !kind || !VALID_KINDS.has(kind)) return null;

  // label = trailer 块之前的内容, 去掉中间分隔的尾随空行。
  const label = lines.slice(0, i + 1).join('\n').replace(/\n+$/, '');

  return {
    label,
    sessionId,
    kind: kind as SnapshotKind,
    ...(anchor ? { anchor } : {}),
    ...(rollbackId ? { rollbackId } : {}),
    ...(rollbackTarget ? { rollbackTarget } : {}),
    ...(reverts?.length ? { reverts } : {}),
    ...(protectRef ? { protectRef } : {}),
    ...(branch ? { branch } : {}),
  };
}
