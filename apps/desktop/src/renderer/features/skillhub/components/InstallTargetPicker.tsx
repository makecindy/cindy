/**
 * InstallTargetPicker — F-UI-2
 *
 * 选择安装位置的弹窗。市场 Clone 与本地导入共用。
 *
 * 布局：固定全屏蒙版 + 居中弹窗（width=480, cornerRadius=12）。
 * 行高：全局行 + 项目行均为 h-12 (48px)，超出 4 行时容器内可滚动。
 *
 * 安装路径策略：
 *   - 全局：不传 installPath，main 内部默认 ~/.agents/skills/<name>/（双引擎共享）
 *   - 项目：传完整 installPath = joinSkillInstallPath(projectRoot, name)
 *   - 其他目录：dialog.showOpenDirectory 拿到 basePath，拼完整路径传入
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, FolderOpen, Globe } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useProjectsForPicker } from '../hooks/useProjectsForPicker';
import {
  isInstallPathForSkill,
  isInstallPathUnderProject,
  joinSkillInstallPath,
  normalizeInstallPathKey,
} from '../lib/installTargetPaths';
import type { SkillhubCatalogScope } from '../../../../shared/skillhubCatalog';

/** Minimal skill identity for the picker (market Clone or local import). */
export interface InstallTargetSkill {
  name: string;
  /** Shown in import / custom subtitle. */
  versionLabel?: string;
  /** Market Clone passes latestVersion; used when versionLabel is absent. */
  latestVersion?: string | number;
  description?: string;
  catalogScope?: SkillhubCatalogScope;
}

export type InstallTargetActionResult =
  | { success: true; absolutePath?: string }
  | { success: false; errorCode?: string; message?: string };

interface InstallTargetPickerProps {
  open: boolean;
  skill: InstallTargetSkill | null;
  onClose: () => void;
  onInstallComplete: (result?: { absolutePath?: string; name: string }) => void;
  /**
   * Install / import executor. Defaults to market `skillhub.install`.
   * Import mode passes a closure that calls `skillhub.importLocal`.
   */
  runAction?: (params: {
    name: string;
    installPath?: string;
    force?: boolean;
    catalogScope?: SkillhubCatalogScope;
  }) => Promise<InstallTargetActionResult>;
  /** i18n key override for dialog title (default installPicker.title). */
  titleKey?: string;
  /** When set, subtitle uses this key with { name, version, description }. */
  subtitleKey?: string;
  successToastKey?: string;
  failedToastKey?: string;
}

// 最多可见的项目行数（超出滚动）
const MAX_VISIBLE_PROJECTS = 4;
const PROJECT_ROW_H = 48;
const INSTALL_PICKER_TITLE_ID = 'skillhub-install-picker-title';

async function runMarketInstall(params: {
  name: string;
  installPath?: string;
  force?: boolean;
  catalogScope?: SkillhubCatalogScope;
}): Promise<InstallTargetActionResult> {
  return window.electronAPI.skillhub.install({
    name: params.name,
    installPath: params.installPath,
    force: params.force,
    catalogScope: params.catalogScope,
  });
}

export function InstallTargetPicker({
  open,
  skill,
  onClose,
  onInstallComplete,
  runAction = runMarketInstall,
  titleKey = 'skillhub.installPicker.title',
  subtitleKey = 'skillhub.installPicker.subtitle',
  successToastKey = 'skillhub.installPicker.installSuccess',
  failedToastKey = 'skillhub.installPicker.installFailed',
}: InstallTargetPickerProps) {
  const { t } = useTranslation();
  const { projects, loading: projectsLoading } = useProjectsForPicker();
  const { confirm } = useConfirmDialog();
  const [installing, setInstalling] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [installedPaths, setInstalledPaths] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open || !skill) return;
    let cancelled = false;
    void window.electronAPI.skillhub.registry
      .getByName({ name: skill.name })
      .then((res) => {
        if (cancelled || !res.success || !res.manifest) return;
        const paths = new Map<string, string>();
        for (const [p, entry] of Object.entries(res.manifest.installs)) {
          paths.set(normalizeInstallPathKey(p), entry.version);
        }
        setInstalledPaths(paths);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, skill?.name]);

  useEffect(() => {
    if (!open) {
      setBannerError(null);
      setInstalling(false);
    }
  }, [open]);

  if (!open || !skill) return null;

  const getInstalledVersion = (targetPath: string): string | null => {
    return installedPaths.get(normalizeInstallPathKey(targetPath)) ?? null;
  };

  // Global 行：找 registry 中不属于任何 projectRoot 的条目
  const globalInstalledVersion = (() => {
    for (const [p, v] of installedPaths) {
      if (!isInstallPathForSkill(p, skill.name)) continue;
      const isProjectPath = projects.some((proj) => isInstallPathUnderProject(p, proj.projectRoot));
      if (!isProjectPath) return v;
    }
    return null;
  })();

  const handleInstall = async (installPath?: string) => {
    setBannerError(null);
    setInstalling(true);
    try {
      const res = await runAction({ name: skill.name, installPath, catalogScope: skill.catalogScope });
      if (res.success) {
        toast.success(
          t(successToastKey, {
            name: skill.name,
            suffix: res.absolutePath ? ` → ${res.absolutePath}` : '',
          }),
        );
        onInstallComplete({ name: skill.name, absolutePath: res.absolutePath });
        return;
      }
      if (res.errorCode === 'CONFLICT_USER_OWNED') {
        const targetLabel = installPath ?? '~/.agents/skills';
        const ok = await confirm({
          title: t('skillhub.installPicker.conflictDialog.title'),
          description: t('skillhub.installPicker.conflictDialog.description', {
            path: targetLabel,
            name: skill.name,
          }),
          confirmText: t('skillhub.installPicker.conflictDialog.confirm'),
          cancelText: t('skillhub.installPicker.conflictDialog.cancel'),
        });
        if (!ok) return;
        const forced = await runAction({ name: skill.name, installPath, force: true, catalogScope: skill.catalogScope });
        if (forced.success) {
          toast.success(
            t(successToastKey, {
              name: skill.name,
              suffix: forced.absolutePath ? ` → ${forced.absolutePath}` : '',
            }),
          );
          onInstallComplete({ name: skill.name, absolutePath: forced.absolutePath });
        } else if (forced.errorCode !== 'CANCELLED') {
          setBannerError(forced.message ?? t(failedToastKey));
        }
        return;
      }
      if (res.errorCode !== 'CANCELLED') {
        setBannerError(res.message ?? t(failedToastKey));
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleOtherDirectory = async () => {
    const r = await window.electronAPI.dialog.showOpenDirectory({});
    if (!r.success || !r.path) return;
    const installPath = joinSkillInstallPath(r.path, skill.name);
    await handleInstall(installPath);
  };

  const versionForSubtitle = String(skill.versionLabel ?? skill.latestVersion ?? '');

  const dialog = (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center">
      <button
        type="button"
        aria-label={t('skillhub.common.close')}
        className="absolute inset-0 h-full w-full cursor-default"
        style={{ backgroundColor: 'var(--overlay-modal)' }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={INSTALL_PICKER_TITLE_ID}
        className={cn(
          'relative flex flex-col rounded-xl bg-[var(--cmd-palette-bg)] shadow-[var(--shadow-menu)]',
          'border border-[var(--cmd-palette-border)]',
        )}
        style={{ width: '480px' }}
      >
        <div
          className="flex items-start justify-between gap-3"
          style={{ padding: '20px 18px 12px 18px' }}
        >
          <div className="flex min-w-0 flex-col" style={{ gap: '6px' }}>
            <span
              id={INSTALL_PICKER_TITLE_ID}
              className="text-[var(--msg-assistant-text)]"
              style={{ fontSize: '16px', fontWeight: 500 }}
            >
              {t(titleKey)}
            </span>
            <span className="truncate text-[var(--cmd-palette-item-meta)]" style={{ fontSize: '12px' }}>
              {t(subtitleKey, {
                name: skill.name,
                version: versionForSubtitle,
                description: skill.description ?? '',
              })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleOtherDirectory();
            }}
            disabled={installing}
            className={cn(
              'flex shrink-0 items-center gap-[6px] rounded-full transition-colors',
              'border border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--settings-btn-secondary-text)]',
              'hover:bg-[var(--surface-hover)]',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            style={{ height: '32px', padding: '0 12px', fontSize: '12px', fontWeight: 500 }}
          >
            <FolderOpen size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
            {t('skillhub.installPicker.otherDirectory')}
          </button>
        </div>

        {bannerError && (
          <div className="mx-2 mb-1 rounded-lg border border-[var(--cmd-palette-border)] bg-transparent px-4 py-2 text-sm text-[var(--settings-section-desc)]">
            {bannerError}
          </div>
        )}

        <div className="flex flex-col" style={{ padding: '4px 12px 12px 12px' }}>
          <button
            type="button"
            disabled={installing || !!globalInstalledVersion}
            onClick={() => {
              void handleInstall(undefined);
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl text-left transition-colors',
              'border border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))]',
              globalInstalledVersion
                ? 'opacity-50 cursor-default'
                : 'hover:bg-[var(--settings-menu-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            style={{ height: `${PROJECT_ROW_H}px`, padding: '0 12px' }}
          >
            <div
              className="flex shrink-0 items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)]"
              style={{ width: '28px', height: '28px' }}
            >
              <Globe size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '2px' }}>
              <span className="text-[var(--msg-assistant-text)]" style={{ fontSize: '13px', fontWeight: 500 }}>
                {t('skillhub.installPicker.global')}
              </span>
              <span className="truncate text-[var(--cmd-palette-item-meta)]" style={{ fontSize: '11px' }}>
                ~/.agents/skills/{skill.name}
              </span>
            </div>
            {globalInstalledVersion ? (
              <span
                className="flex shrink-0 items-center gap-1 text-[var(--cmd-palette-item-meta)]"
                style={{ fontSize: '11px' }}
              >
                <Check size={12} /> v{globalInstalledVersion}
              </span>
            ) : (
              <ChevronRight size={14} className="shrink-0 text-[var(--chat-input-placeholder)]" />
            )}
          </button>

          <div className="flex items-center gap-[10px]" style={{ padding: '10px 8px 6px 8px' }}>
            <span
              className="shrink-0 text-[var(--settings-theme-icon)]"
              style={{ fontSize: '10px', fontWeight: 500, letterSpacing: '0.5px' }}
            >
              {t('skillhub.installPicker.projects')}
            </span>
            <div className="h-px flex-1 bg-[var(--cmd-palette-border)]" />
          </div>

          {projectsLoading ? (
            <div
              className="flex items-center justify-center text-sm text-[var(--cmd-palette-item-meta)]"
              style={{ height: `${PROJECT_ROW_H}px` }}
            >
              {t('skillhub.installPicker.loadingProjects')}
            </div>
          ) : projects.length === 0 ? (
            <div
              className="flex items-center justify-center text-sm text-[var(--chat-input-placeholder)]"
              style={{ height: `${PROJECT_ROW_H}px` }}
            >
              {t('skillhub.installPicker.noProjects')}
            </div>
          ) : (
            <div
              className="flex flex-col overflow-y-auto"
              style={{
                maxHeight: `${MAX_VISIBLE_PROJECTS * PROJECT_ROW_H + (MAX_VISIBLE_PROJECTS - 1) * 2}px`,
                gap: '2px',
              }}
            >
              {projects.map((p) => {
                const installPath = joinSkillInstallPath(p.projectRoot, skill.name);
                const rowVersion = getInstalledVersion(installPath);
                const isRowInstalled = !!rowVersion;
                return (
                  <button
                    key={p.projectRoot}
                    type="button"
                    disabled={installing || isRowInstalled}
                    onClick={() => {
                      void handleInstall(installPath);
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl text-left transition-colors',
                      'border border-[var(--cmd-palette-border)] bg-[hsl(var(--content-area))]',
                      isRowInstalled
                        ? 'opacity-50 cursor-default'
                        : 'hover:bg-[var(--settings-menu-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                    style={{ height: `${PROJECT_ROW_H}px`, padding: '0 12px' }}
                  >
                    <div
                      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)]"
                      style={{ width: '28px', height: '28px' }}
                    >
                      <FolderOpen size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '2px' }}>
                      <span
                        className="truncate text-[var(--msg-assistant-text)]"
                        style={{ fontSize: '13px', fontWeight: 500 }}
                      >
                        {p.displayName}
                      </span>
                      <span className="truncate text-[var(--cmd-palette-item-meta)]" style={{ fontSize: '11px' }}>
                        {installPath}
                      </span>
                    </div>
                    {isRowInstalled ? (
                      <span
                        className="flex shrink-0 items-center gap-1 text-[var(--cmd-palette-item-meta)]"
                        style={{ fontSize: '11px' }}
                      >
                        <Check size={12} /> v{rowVersion}
                      </span>
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-[var(--chat-input-placeholder)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
