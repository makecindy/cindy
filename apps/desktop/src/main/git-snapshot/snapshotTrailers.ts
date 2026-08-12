/**
 * git-snapshot: 保存点元数据 ⇄ commit message 的序列化/解析。
 *
 * 设计取舍(见产品设计稿《事实源选择》): git history 是保存点的唯一事实源,
 * 不另起 SQLite 表。每个保存点把受控元数据用 git 原生 trailer
 * (commit message 末尾的 `Key: value` 脚注)写进 commit, 时间线 = 解析 git log。
 *
 * 纯函数, 无 IO。trailer 私有前缀保证不和用户自己的 commit 混淆,
 * 非保存点 commit 一律 parse 成 null(时间线只认我们建的点)。
 *
 * 两代格式并存:
 * - X-XDT-*(legacy): 旧版把保存点直接 commit 到用户当前分支时写入的前缀。
 *   仅保留解析与旧执行器路径, 不再产生新提交。
 * - X-Cindy-*: shadow savepoint(挂在 refs/cindy/savepoints/<sessionId>
 *   隐藏引用下, 不移动 HEAD)使用的前缀。
 */

/** 保存点 / rollback 提交的受控来源。 */
const SNAPSHOT_KIND_VALUES = [
  'turn-start',
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
  /** 回退前保护 ref, 用于审计或灾难恢复(仅 legacy)。 */
  protectRef?: string;
  /** 创建保存点时所在分支, legacy 用于隔离时间线, shadow 仅作展示/审计。 */
  branch?: string;
  /** 创建保存点时的 HEAD commit(shadow), unborn HEAD 时缺省。仅审计。 */
  baseHead?: string;
  /** after-edit 对应的本 turn turn-start 保存点 commit(shadow)。 */
  baselineCommit?: string;
  /** rollback marker 记录的 pre-rollback 保存点 commit(shadow), 补偿/审计锚点。 */
  preRollbackCommit?: string;
}

/** 保存点 trailer 前缀代际。 */
export type SnapshotTrailerSource = 'legacy-xdt' | 'cindy';

/** 从 commit message 解析回来的保存点。 */
export interface ParsedSnapshot extends SnapshotMeta {
  /** commit message 的正文(trailer 之前的部分), 即时间线展示名。 */
  label: string;
  /** 该保存点使用的 trailer 前缀代际。 */
  source: SnapshotTrailerSource;
}

const KEY_SESSION = 'Session';
const KEY_KIND = 'Kind';
const KEY_ANCHOR = 'Anchor';
const KEY_ROLLBACK_ID = 'RollbackId';
const KEY_ROLLBACK_TARGET = 'RollbackTarget';
const KEY_REVERTS = 'Reverts';
const KEY_PROTECT_REF = 'ProtectRef';
const KEY_BRANCH = 'Branch';
const KEY_BASE_HEAD = 'BaseHead';
const KEY_BASELINE = 'Baseline';
const KEY_PRE_ROLLBACK = 'PreRollback';

const PREFIX_BY_SOURCE: Record<SnapshotTrailerSource, string> = {
  'legacy-xdt': 'X-XDT',
  cindy: 'X-Cindy',
};

/** 一行保存点 trailer 的匹配: `X-XDT-Xxx: value` 或 `X-Cindy-Xxx: value`。 */
const SNAPSHOT_TRAILER_RE = /^X-(XDT|Cindy)-([A-Za-z0-9]+):\s?(.*)$/;

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

function buildTrailerBlock(prefix: string, meta: SnapshotMeta): string {
  const trailers: string[] = [
    `${prefix}-${KEY_SESSION}: ${meta.sessionId}`,
    `${prefix}-${KEY_KIND}: ${meta.kind}`,
  ];
  if (meta.anchor) {
    trailers.push(`${prefix}-${KEY_ANCHOR}: ${meta.anchor}`);
  }
  if (meta.rollbackId) {
    trailers.push(`${prefix}-${KEY_ROLLBACK_ID}: ${meta.rollbackId}`);
  }
  if (meta.rollbackTarget) {
    trailers.push(`${prefix}-${KEY_ROLLBACK_TARGET}: ${meta.rollbackTarget}`);
  }
  if (meta.reverts?.length) {
    trailers.push(`${prefix}-${KEY_REVERTS}: ${meta.reverts.join(',')}`);
  }
  if (meta.protectRef) {
    trailers.push(`${prefix}-${KEY_PROTECT_REF}: ${meta.protectRef}`);
  }
  if (meta.branch) {
    trailers.push(`${prefix}-${KEY_BRANCH}: ${meta.branch}`);
  }
  if (meta.baseHead) {
    trailers.push(`${prefix}-${KEY_BASE_HEAD}: ${meta.baseHead}`);
  }
  if (meta.baselineCommit) {
    trailers.push(`${prefix}-${KEY_BASELINE}: ${meta.baselineCommit}`);
  }
  if (meta.preRollbackCommit) {
    trailers.push(`${prefix}-${KEY_PRE_ROLLBACK}: ${meta.preRollbackCommit}`);
  }
  return trailers.join('\n');
}

/**
 * 组装 legacy commit message: 正文 label + 空行 + X-XDT-* trailer 块。
 * 仅供旧格式(直接 commit 到用户分支)的既有路径使用, 新代码用
 * buildCindyCommitMessage。anchor 等缺省时不产生空 trailer 行。
 */
export function buildCommitMessage(label: string, meta: SnapshotMeta): string {
  return `${label}\n\n${buildTrailerBlock(PREFIX_BY_SOURCE['legacy-xdt'], meta)}`;
}

/** 组装 shadow savepoint 的 commit message(X-Cindy-* trailer 块)。 */
export function buildCindyCommitMessage(label: string, meta: SnapshotMeta): string {
  return `${label}\n\n${buildTrailerBlock(PREFIX_BY_SOURCE.cindy, meta)}`;
}

interface CollectedTrailerFields {
  sessionId?: string;
  kind?: string;
  anchor?: string;
  rollbackId?: string;
  rollbackTarget?: string;
  reverts?: string[];
  protectRef?: string;
  branch?: string;
  baseHead?: string;
  baselineCommit?: string;
  preRollbackCommit?: string;
}

function assignTrailerField(fields: CollectedTrailerFields, key: string, value: string): void {
  if (key === KEY_SESSION) fields.sessionId = value;
  else if (key === KEY_KIND) fields.kind = value;
  else if (key === KEY_ANCHOR) fields.anchor = value;
  else if (key === KEY_ROLLBACK_ID) fields.rollbackId = value;
  else if (key === KEY_ROLLBACK_TARGET) fields.rollbackTarget = value;
  else if (key === KEY_REVERTS) {
    fields.reverts = value.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (key === KEY_PROTECT_REF) fields.protectRef = value;
  else if (key === KEY_BRANCH) fields.branch = value;
  else if (key === KEY_BASE_HEAD) fields.baseHead = value;
  else if (key === KEY_BASELINE) fields.baselineCommit = value;
  else if (key === KEY_PRE_ROLLBACK) fields.preRollbackCommit = value;
}

function toParsedSnapshot(
  fields: CollectedTrailerFields,
  label: string,
  source: SnapshotTrailerSource,
): ParsedSnapshot | null {
  const { sessionId, kind } = fields;
  if (!sessionId || !kind || !VALID_KINDS.has(kind)) return null;
  return {
    label,
    source,
    sessionId,
    kind: kind as SnapshotKind,
    ...(fields.anchor ? { anchor: fields.anchor } : {}),
    ...(fields.rollbackId ? { rollbackId: fields.rollbackId } : {}),
    ...(fields.rollbackTarget ? { rollbackTarget: fields.rollbackTarget } : {}),
    ...(fields.reverts?.length ? { reverts: fields.reverts } : {}),
    ...(fields.protectRef ? { protectRef: fields.protectRef } : {}),
    ...(fields.branch ? { branch: fields.branch } : {}),
    ...(fields.baseHead ? { baseHead: fields.baseHead } : {}),
    ...(fields.baselineCommit ? { baselineCommit: fields.baselineCommit } : {}),
    ...(fields.preRollbackCommit ? { preRollbackCommit: fields.preRollbackCommit } : {}),
  };
}

/**
 * 解析 commit message(通常来自 git log %B)。
 *
 * 策略: 从末尾向上收集"连续的 git trailer 行"作为 trailer 块, 再筛
 * X-XDT-* / X-Cindy-*。因为 label 行不会以这两个前缀开头, 即使 label 含
 * 冒号/换行也不会误判。两种前缀同时出现时(实际不会发生)X-Cindy 优先。
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

  const cindyFields: CollectedTrailerFields = {};
  const legacyFields: CollectedTrailerFields = {};
  for (const line of unfoldTrailerLines(trailerLines)) {
    const match = SNAPSHOT_TRAILER_RE.exec(line);
    if (!match) continue;
    const [, prefixTag, key, rawValue] = match;
    const fields = prefixTag === 'Cindy' ? cindyFields : legacyFields;
    assignTrailerField(fields, key, rawValue.trim());
  }

  // label = trailer 块之前的内容, 去掉中间分隔的尾随空行。
  const label = lines.slice(0, i + 1).join('\n').replace(/\n+$/, '');

  return (
    toParsedSnapshot(cindyFields, label, 'cindy') ??
    toParsedSnapshot(legacyFields, label, 'legacy-xdt')
  );
}
