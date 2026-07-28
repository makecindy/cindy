import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

/**
 * issue_confirm IPC 里的构建区域。非法或缺失一律返回 undefined —— 确认卡片宁可
 * 不展示区域，也不能把用户的 CN 版说成默认版。
 *
 * 写成字面量比较而非「数组 + includes + as CindyRegion」：narrowing 直接得出
 * `CindyRegion`，不需要类型断言，也就不会在 `CindyRegion` 改动后继续静默通过。
 * 新增区域时的漏改由同族的 `shared/issueRegionCode.ts` 兜住——那里的
 * `Record<CindyRegion, …>` 会编译报错，改它时会一并看到本函数。
 */
export function parseIssueEnvRegion(raw: unknown): CindyRegion | undefined {
  return raw === 'cn' || raw === 'global' || raw === 'dev' ? raw : undefined;
}

/** issue_confirm IPC 中的真实 GitHub 提交身份；renderer 只展示，不参与选择。 */
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
