import type { SkillhubCatalogScope } from '../../shared/skillhubCatalog';

export interface HubSkillInfoForDesktop {
  slug: string;
  icon?: string | null;
  displayName?: string;
  summary?: string | null;
  description?: string;
  version: string;
  marketVersion?: string;
  pendingVersion?: {
    version: string;
    status?: string;
  };
  visibilityReview?: {
    requestedVisibility: 'public';
    status: 'pending' | 'rejected';
    reason?: string;
  };
  folderHash?: string;
  fileHash?: string;
  owner: { type?: string; slug: string; name: string };
  publisher?: { name?: string };
  visibility: string;
  moderationStatus?: string;
  updatedAt: string;
  isMine?: boolean;
  canManage?: boolean;
  categories?: Array<{ slug: string; name: string; source?: 'platform' }>;
  tags?: Array<{ slug: string; name: string; source?: 'platform' }>;
  githubUrl?: string | null;
  stats?: {
    downloads?: number;
  };
}

interface MapOptions {
  forceMine?: boolean;
  catalogScope?: SkillhubCatalogScope;
}

export function mapHubSkillInfoToDesktopInfo(hub: HubSkillInfoForDesktop, opts?: MapOptions) {
  return {
    name: hub.slug,
    icon: hub.icon,
    displayName: hub.displayName ?? hub.slug,
    description: hub.summary ?? hub.description ?? '',
    authorId: hub.owner.slug,
    authorName: hub.owner.name,
    publisherName: hub.publisher?.name?.trim() || hub.owner.name,
    authorAvatarUrl: null as string | null,
    isMine: opts?.forceMine === true || hub.isMine === true,
    canManage: hub.canManage === true,
    latestVersion: hub.version,
    folderHash: hub.folderHash ?? hub.fileHash,
    visibility: (hub.visibility === 'public' ? 'PUBLIC' : 'DEPARTMENT_SCOPED') as 'PUBLIC' | 'DEPARTMENT_SCOPED',
    publishedVisibility: (hub.visibility === 'private' || hub.visibility === 'shared' || hub.visibility === 'public'
      ? hub.visibility
      : undefined) as 'private' | 'shared' | 'public' | undefined,
    ownerType: hub.owner.type as string | undefined,
    moderationStatus: hub.moderationStatus,
    marketVersion: hub.marketVersion,
    pendingVersion: hub.pendingVersion,
    visibilityReview: hub.visibilityReview,
    visibleDeptIds: [] as string[],
    categories: (hub.categories ?? []).map((category) => category.slug),
    tags: (hub.tags ?? hub.categories ?? []).map((tag) => ({
      slug: tag.slug,
      name: tag.name,
      ...(tag.source ? { source: tag.source } : {}),
    })),
    githubUrl: hub.githubUrl,
    publishedAt: hub.updatedAt,
    downloads: Number.isFinite(hub.stats?.downloads) ? hub.stats?.downloads ?? 0 : 0,
    latestPublishedFromDeviceId: null as string | null,
    catalogScope: opts?.catalogScope,
  };
}
