/**
 * 「IM 机器人」页的插件入口：声明了 `imEntrance` 的已启用插件。
 *
 * 这些插件读 IM 共用的「项目与模型」（与官方机器人同一份），可按聊天单独覆盖模型与权限；
 * 登录、绑定和按聊天的设置都在插件自己的页面里，这里只负责让用户找到它们。
 * 契约见 docs/dev-rules/protocol-compatibility/plugin-im-projects.md。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import type { InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';

/** Enabled plugins that declare an IM entrance; the declaration itself grants nothing. */
export function isImEntrancePlugin(ghost: InstalledGhost): boolean {
  return ghost.enabled && ghost.manifest.imEntrance === true &&
    ghost.manifest.agent?.tasks === true && ghost.manifest.agent?.targets === true;
}

export function useImEntrancePlugins(): InstalledGhost[] {
  const ghosts = useInstalledGhosts();
  return useMemo(() => ghosts.filter(isImEntrancePlugin), [ghosts]);
}

export function ImPluginEntrancesCard({ plugins }: { plugins: InstalledGhost[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <SettingsCard>
      {plugins.map((plugin) => {
        const storagePart = installedGhostStoragePart(plugin);
        return (
          <SettingsRow
            key={storagePart}
            media
            wrap
            lead={<GhostPluginIcon iconId={plugin.manifest.id} iconName={plugin.manifest.name} iconDataUrl={plugin.iconDataUrl} size="sm" />}
            title={plugin.manifest.name}
            hint={t('settings.imBot.plugins.rowHint')}
            trailing={
              <Button
                data-settings-search-action="Open this IM plugin's own page for sign-in, linking and per-chat settings"
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/plugins?ghost=${encodeURIComponent(storagePart)}`)}
              >
                {t('settings.imBot.plugins.open')}
              </Button>
            }
          />
        );
      })}
    </SettingsCard>
  );
}
