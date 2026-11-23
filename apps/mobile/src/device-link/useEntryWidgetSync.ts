/**
 * 把「新建任务 + 伙伴」写进 Android 桌面入口组件。
 *
 * 桌面组件的目标不是系统的快捷方式列表：这里只写一个快照，交给系统的「添加小组件」。
 * 组件不联网，所以深链和图标必须一次性带上。
 *
 * 只在目标内容真的变化时写；图标按「伙伴 + 头像签名」缓存，改名不会重新取图。
 */
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  cindyEntryWidget,
  writeEntryWidgetTargets,
  type EntryWidgetIcon,
  type EntryWidgetTarget,
} from '../../modules/cindy-entry-widget/src';
import type { DesktopEntryIcon } from './desktopEntryIcon';
import {
  desktopEntryAvatarSignature,
  desktopEntryDestinationUrl,
  desktopEntryId,
  desktopEntryTitle,
} from './desktopEntryModel';
import { desktopEntryScheme } from './desktopEntryScheme';
import { useDesktopEntryIconResolver } from './useDesktopEntryIconResolver';
import { useDesktopEntryRows } from './useDesktopEntryRows';

/** 原生只认「图」和「字」两种图标；品牌图标走应用图标兜底。 */
function widgetIcon(icon: DesktopEntryIcon): EntryWidgetIcon | undefined {
  if (icon.kind === 'image' && icon.pngBase64) {
    return { kind: 'image', pngBase64: icon.pngBase64, background: icon.background };
  }
  if (icon.kind === 'glyph' && icon.text) {
    return { kind: 'glyph', text: icon.text, background: icon.background };
  }
  return undefined;
}

export function useEntryWidgetSync(ready: boolean) {
  const rows = useDesktopEntryRows();
  const { t } = useTranslation();
  const resolveIcon = useDesktopEntryIconResolver();
  const icons = useRef(new Map<string, EntryWidgetIcon | undefined>());
  const written = useRef('');
  const running = useRef(false);

  const run = useCallback(async () => {
    if (!ready || !cindyEntryWidget || running.current) return;
    running.current = true;
    try {
      const scheme = desktopEntryScheme();
      const targets: EntryWidgetTarget[] = [{
        id: desktopEntryId({ kind: 'new-task' }),
        title: desktopEntryTitle(t('settings.entryWidget.cindyTask'), 'Cindy'),
        subtitle: '',
        url: desktopEntryDestinationUrl({ kind: 'new-task' }, scheme),
      }];
      const signature: string[] = [`new-task|${targets[0].title}|${scheme}`];
      for (const row of rows) {
        const link = {
          kind: 'companion' as const,
          deviceId: row.deviceId,
          collectionId: row.collectionId,
          companionId: row.companionId,
          sessionId: row.sessionId,
        };
        const id = desktopEntryId(link);
        // 头像签名进缓存键与内容签名：换了头像才重新取图，改名 / 换电脑名不重新取。
        const avatarSignature = desktopEntryAvatarSignature(row.avatar);
        const cacheKey = `${id}:${avatarSignature}`;
        if (!icons.current.has(cacheKey)) {
          icons.current.set(cacheKey, widgetIcon(await resolveIcon({
            avatar: row.avatar,
            title: row.title,
            deviceId: row.deviceId,
            online: row.online,
          })));
        }
        const title = desktopEntryTitle(row.title, '');
        const subtitle = row.deviceName ?? '';
        targets.push({
          id,
          title,
          subtitle,
          url: desktopEntryDestinationUrl(link, scheme),
          icon: icons.current.get(cacheKey),
        });
        signature.push(`${id}|${title}|${subtitle}|${cacheKey}|${scheme}`);
      }
      // 只比较轻量签名：图标 base64 很大，不参与比较。
      const next = signature.join('\n');
      if (next === written.current) return;
      if (await writeEntryWidgetTargets(targets)) written.current = next;
    } finally {
      running.current = false;
    }
  }, [ready, resolveIcon, rows, t]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void run();
  }, [run, t]);
}
