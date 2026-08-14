import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Copy, Pencil, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { ProfileEditDialog } from './ProfileEditDialog';

const ORGANIZATION_ROLE_I18N_KEYS = {
  owner: 'settings.userProfile.organization.roles.owner',
  admin: 'settings.userProfile.organization.roles.admin',
  member: 'settings.userProfile.organization.roles.member',
} as const;

type OrganizationRole = keyof typeof ORGANIZATION_ROLE_I18N_KEYS;

function isOrganizationRole(role: string): role is OrganizationRole {
  return role === 'owner' || role === 'admin' || role === 'member';
}

function getOrganizationRoleI18nKey(role: string) {
  return ORGANIZATION_ROLE_I18N_KEYS[isOrganizationRole(role) ? role : 'member'];
}

// 展示用缩写:长 ID 只露头尾便于目视比对,点击复制的仍是完整值。
function abbreviateUserId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function UserProfileCard() {
  const { user, mode, exitLocalMode } = useAuth();
  const navigate = useNavigate();
  const [avatarError, setAvatarError] = useState(false);
  const [orgLogoError, setOrgLogoError] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { t } = useTranslation();
  // aria-label(动作)会覆盖子文本作为可访问名称;可见的 ID 文本经 aria-describedby
  // 暴露给辅助技术,让读屏用户复制前也能核对 ID。
  const userIdDescriptionId = useId();

  // 换头像(服务端资料更新)后给新地址重试的机会,
  // 不让一次历史加载失败永远钉死在首字母兜底上。
  const avatarUrl = user?.avatar ?? null;
  useEffect(() => {
    setAvatarError(false);
  }, [avatarUrl]);

  const orgLogoUrl = user?.orgLogoUrl ?? null;
  useEffect(() => {
    setOrgLogoError(false);
  }, [orgLogoUrl]);

  const handleLocalSignIn = async () => {
    try {
      await exitLocalMode();
    } catch {
      // Continue to the login recovery surface; main remains fail closed while
      // the durable owner transition is incomplete.
    }
    navigate('/login');
  };

  if (!user && mode === 'local') {
    return (
      <div
        className={cn(
          'flex w-full items-center gap-[14px] rounded-xl p-5',
          'bg-[var(--settings-profile-card-bg)]',
          'border border-[var(--settings-profile-card-border)]',
        )}
      >
        {/* 未登录态没有身份可展示:用中性人形图标,不取文案首字(会渲染成「未」/「N」
            这类无意义字符,且四语各不相同)。 */}
        <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border border-[var(--settings-profile-card-border)] bg-[var(--settings-profile-avatar-bg)] text-[var(--settings-profile-avatar-text)]">
          <UserRound aria-hidden="true" size={22} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-18 font-medium text-[var(--settings-profile-name)]">
            {t('settings.userProfile.local.name')}
          </p>
          <p className="mt-1 text-12 text-[var(--text-tertiary)]">
            {t('settings.userProfile.local.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => void handleLocalSignIn()}
            className="rounded-full border border-[var(--border-default)] px-3 py-1.5 text-12 text-[var(--text-primary)] transition-colors hover:bg-[var(--settings-profile-avatar-bg)]"
          >
            {t('settings.userProfile.local.signIn')}
          </button>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const displayName = user.name || t('settings.userProfile.fallbackName');
  const initial = displayName.charAt(0).toUpperCase();
  const avatarAlt = t('settings.userProfile.avatarAlt', { name: displayName });
  const organizationName =
    user.membershipKind === 'org'
      ? user.orgName?.trim() ||
        user.orgSlug?.trim() ||
        t('settings.userProfile.organization.fallbackName')
      : null;
  const organizationRole =
    user.membershipKind === 'org' ? t(getOrganizationRoleI18nKey(user.membershipRole)) : null;

  const handleCopyUserId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      toast.success(t('settings.userProfile.copyUserId.success'));
    } catch {
      toast.error(t('settings.userProfile.copyUserId.failed'));
    }
  };

  return (
    <div
      className={cn(
        'flex w-full items-center gap-[14px] rounded-xl p-5',
        'bg-[var(--settings-profile-card-bg)]',
        'border border-[var(--settings-profile-card-border)]',
      )}
    >
      {/* Avatar — 52×52 pill;点击与右侧铅笔一样打开编辑弹窗 */}
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        aria-label={t('settings.userProfile.edit.open')}
        title={t('settings.userProfile.edit.open')}
        className={cn(
          'group relative h-[52px] w-[52px] shrink-0 cursor-pointer rounded-full',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        {user.avatar && !avatarError ? (
          <img
            src={user.avatar}
            alt={avatarAlt}
            className={cn(
              'h-[52px] w-[52px] rounded-full object-cover',
              'transition-opacity group-hover:opacity-80',
            )}
            onError={() => setAvatarError(true)}
          />
        ) : (
          <div
            className={cn(
              'flex h-[52px] w-[52px] items-center justify-center rounded-full',
              'bg-[var(--settings-profile-avatar-bg)]',
              // 无头像的首字母兜底加一圈细描边,与卡片边框同 token,避免圆盘悬空
              'border border-[var(--settings-profile-card-border)]',
              'text-18 font-medium text-[var(--settings-profile-avatar-text)]',
              'transition-colors group-hover:bg-[var(--settings-profile-card-border)]',
            )}
          >
            {initial}
          </div>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className="min-w-0 truncate text-18 font-medium leading-[1.2] text-[var(--settings-profile-name)]">
          {displayName}
        </p>
        {/* User ID — 显式展示,整行点击复制;常驻小图标明示可复制。 */}
        <button
          type="button"
          onClick={() => void handleCopyUserId()}
          aria-label={t('settings.userProfile.copyUserId.action')}
          aria-describedby={userIdDescriptionId}
          title={t('settings.userProfile.copyUserId.action')}
          className={cn(
            '-ml-1.5 mt-0.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-left',
            'text-12 text-[var(--text-tertiary)] transition-colors',
            'hover:bg-[var(--settings-profile-avatar-bg)] hover:text-[var(--text-secondary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          )}
        >
          <span id={userIdDescriptionId} className="min-w-0 truncate">
            {t('settings.userProfile.copyUserId.display', { id: abbreviateUserId(user.id) })}
          </span>
          <Copy aria-hidden="true" size={11} className="shrink-0" />
        </button>
        {organizationName && organizationRole && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm leading-5 text-[var(--text-secondary)]">
            {orgLogoUrl && !orgLogoError ? (
              <img
                src={orgLogoUrl}
                alt=""
                aria-hidden="true"
                onError={() => setOrgLogoError(true)}
                className="h-[14px] w-[14px] shrink-0 rounded-full object-cover"
              />
            ) : (
              <Building2 aria-hidden="true" className="shrink-0" size={14} />
            )}
            <span className="min-w-0 truncate" title={organizationName}>
              {t('settings.userProfile.organization.label', { name: organizationName })}
            </span>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-xs leading-4',
                'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
              )}
            >
              {organizationRole}
            </span>
          </div>
        )}
      </div>

      {/* 编辑名字 / 头像(直写服务端,弹窗见 ProfileEditDialog) */}
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        aria-label={t('settings.userProfile.edit.open')}
        title={t('settings.userProfile.edit.open')}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          'text-[var(--text-tertiary)] transition-colors',
          'hover:bg-[var(--settings-profile-avatar-bg)] hover:text-[var(--text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <Pencil size={15} />
      </button>

      <ProfileEditDialog open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
