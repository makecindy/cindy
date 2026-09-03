export type PublishVisibility = 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE';

/** 发布者(归属):个人 = 仅自己可管理;团队 = 团队成员可共同管理 */
export type PublisherMode = 'personal' | 'team';

export interface PublishFormValues {
  name: string;
  version: string;
  displayName: string;
  summary: string;
  description: string;
  visibility: PublishVisibility;
  publisherMode: PublisherMode;
  /** 发布团队:od- 开头是飞书一级部门 ID,其余是团队 slug。publisherMode=team 时必填 */
  ownerTeamSlug: string;
  visibleDeptIds: string[];
  sharedTeamSlugs: string[];
  changelog: string;
  categorySlugs: string[];
}

export interface PublishCategoryOption {
  slug: string;
  name?: string;
}

export type PlatformTagSelectionValidation =
  | { ok: true }
  | { ok: false; reason: 'loading' | 'load-error' | 'empty' | 'invalid' };

export function validatePlatformTagSelection({
  loading,
  error,
  categories = [],
  selectedSlugs,
}: {
  loading: boolean;
  error: string | null;
  categories?: PublishCategoryOption[];
  selectedSlugs: string[];
}): PlatformTagSelectionValidation {
  const slugs = [...new Set(selectedSlugs.map((slug) => slug.trim()).filter(Boolean))];
  if (slugs.length === 0) return { ok: true };
  if (loading) return { ok: false, reason: 'loading' };
  if (error) return { ok: false, reason: 'load-error' };
  if (categories.length === 0) return { ok: false, reason: 'empty' };

  if (slugs.length > 50 || slugs.some((slug) => !categories.some((category) => category.slug === slug))) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

export type VisibilityScopeValidation =
  | { ok: true }
  /** 发布者选了团队但没选具体团队 */
  | { ok: false; reason: 'publisher-team-required' }
  /** 团队可见 + 个人发布者时,至少要选一个可见团队/部门,否则没有人能看到 */
  | { ok: false; reason: 'audience-required' };

/**
 * 可见性与发布者的组合校验,对齐 SkillHub 发布表单规则:
 * - 发布者=团队 → 必须选定发布团队(任意可见性)
 * - 团队可见 + 发布者=个人 → 「谁可以使用」至少选一个(发布者=团队时发布团队天然可见,不强制)
 */
export function validateVisibilityScope(form: Pick<
  PublishFormValues,
  'visibility' | 'publisherMode' | 'ownerTeamSlug' | 'visibleDeptIds' | 'sharedTeamSlugs'
>): VisibilityScopeValidation {
  if (form.publisherMode === 'team' && !form.ownerTeamSlug) {
    return { ok: false, reason: 'publisher-team-required' };
  }
  if (
    form.visibility === 'DEPARTMENT_SCOPED' &&
    form.publisherMode === 'personal' &&
    form.visibleDeptIds.length === 0 &&
    form.sharedTeamSlugs.length === 0
  ) {
    return { ok: false, reason: 'audience-required' };
  }
  return { ok: true };
}

/** od- 前缀是飞书部门 ID,走 deptTeamSlug;其余是普通团队 slug,走 teamSlug */
export function isDeptSlug(slug: string): boolean {
  return slug.startsWith('od-');
}

/** 部门镜像团队 slug(与 Hub team.service 的 deptTeamSlug 同算法) */
export function deptMirrorTeamSlug(deptId: string): string {
  return deptId;
}

/** 兼容迁移前的回显 slug;新请求始终使用 deptMirrorTeamSlug 的结果。 */
export function matchesDeptMirrorTeamSlug(
  deptId: string,
  teamSlug: string,
  teamSource?: string | null,
): boolean {
  if (deptMirrorTeamSlug(deptId) === teamSlug) return true;
  if (teamSource !== 'dept' && teamSource !== 'xdt-maker') return false;
  const sanitized = deptId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dept-${sanitized}` === teamSlug;
}

export function buildSkillhubPublishParams({
  form,
  publishAbsolutePath,
  submitName,
  isFirstPublish,
  ownerType,
  categories = [],
}: {
  form: PublishFormValues;
  publishAbsolutePath: string;
  submitName: string;
  isFirstPublish: boolean;
  /** New SkillHub fixes ownership from the authenticated membership. */
  ownerType?: 'personal' | 'organization' | null;
  categories?: PublishCategoryOption[];
}): SkillhubPublishParams {
  const availableSlugs = new Set(categories.map((category) => category.slug));
  const categorySlugs = [...new Set(form.categorySlugs.map((slug) => slug.trim()).filter(Boolean))]
    .filter((slug) => availableSlugs.has(slug));
  // 私有发布强制个人归属(Hub 约束:private + teamSlug 会 400)
  const teamPublisher = ownerType === undefined
    && form.visibility !== 'PRIVATE' && form.publisherMode === 'team' && form.ownerTeamSlug
    ? form.ownerTeamSlug
    : undefined;

  const params: SkillhubPublishParams = {
    absolutePath: publishAbsolutePath,
    name: submitName,
    isFirstPublish,
    version: form.version,
    displayName: form.displayName,
    summary: form.summary,
    description: form.description,
    ...(isFirstPublish && {
      tags: categorySlugs,
      visibility: form.visibility,
      visibleSlugs: ownerType === undefined && form.visibility === 'DEPARTMENT_SCOPED'
        ? [...form.visibleDeptIds, ...form.sharedTeamSlugs]
        : [],
      ...(teamPublisher
        ? isDeptSlug(teamPublisher)
          ? { deptTeamSlug: teamPublisher }
          : { teamSlug: teamPublisher }
        : {}),
    }),
    ...(form.changelog.trim() && { changelog: form.changelog.trim() }),
  };

  return params;
}
