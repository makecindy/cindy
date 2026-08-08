import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import { normalizeIssuePublicName } from '../../shared/issuePublicName';

/**
 * issue_confirm IPC 里的构建区域。非法或缺失一律返回 undefined —— 确认卡片宁可
 * 不展示区域，也不能把用户的 CN 版说成默认版。
 *
 * 写成字面量比较而非「数组 + includes + as CindyRegion」：narrowing 直接得出
 * `CindyRegion`，不需要类型断言，也就不会在 `CindyRegion` 改动后继续静默通过。
 * 新增区域时的漏改由同族的 `shared/regionCode.ts` 兜住——那里的
 * `Record<CindyRegion, …>` 会编译报错，改它时会一并看到本函数。
 */
export function parseIssueEnvRegion(raw: unknown): CindyRegion | undefined {
  return raw === 'cn' || raw === 'global' || raw === 'dev' ? raw : undefined;
}

/** issue_confirm IPC 中可由用户在确认卡选择的实际提交身份。 */
export type IssueSubmissionIdentity =
  { kind: 'github-user'; login: string } | { kind: 'platform'; login: string };

/** IPC 边界校验，避免身份缺失或半残 payload 渲染成误导性的确认卡。 */
export function parseIssueSubmissionIdentity(raw: unknown): IssueSubmissionIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    (obj.kind !== 'github-user' && obj.kind !== 'platform') ||
    typeof obj.login !== 'string' ||
    !obj.login.trim()
  ) {
    return null;
  }
  return { kind: obj.kind, login: obj.login.trim() };
}

/** 可选 GitHub 用户身份无效时只隐藏该选项，不影响平台确认卡。 */
export function parseOptionalGithubUserIdentity(
  raw: unknown,
): Extract<IssueSubmissionIdentity, { kind: 'github-user' }> | undefined {
  const identity = parseIssueSubmissionIdentity(raw);
  return identity?.kind === 'github-user' ? identity : undefined;
}

/** Main 提供的平台代发建议署名；非法值按缺失处理，由卡片回退为“匿名”。 */
export function parseIssueSuggestedPublicName(raw: unknown): string | undefined {
  return normalizeIssuePublicName(raw) ?? undefined;
}
