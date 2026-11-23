/**
 * 桌面入口的唯一消费者：登录就绪后打开暂存在内存里的目标，
 * 并在同一位置把「新建任务 + 伙伴」写进 Android 桌面组件。
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import {
  consumeDesktopEntryIntent,
  useDesktopEntryIntent,
} from '@/device-link/desktopEntryIntent';
import { useEntryWidgetSync } from './useEntryWidgetSync';

export function DesktopEntryHost({ ready }: { ready: boolean }) {
  const intent = useDesktopEntryIntent();
  const router = useRouter();
  const consumed = useRef(0);
  // 同一份行数据同时喂给 Android 桌面入口组件：系统「添加小组件」里选得到新建任务与伙伴。
  useEntryWidgetSync(ready);

  useEffect(() => {
    if (!ready || !intent || intent.id === consumed.current) return;
    consumed.current = intent.id;
    const link = intent.link;
    consumeDesktopEntryIntent(intent.id);
    if (!link) return;
    if (link.kind === 'new-task') {
      router.push('/sessions/new');
      return;
    }
    router.push({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId: link.sessionId,
        deviceId: link.deviceId,
        resourceCollectionId: link.collectionId,
        resourceId: link.companionId,
        resourceKind: 'bot',
      },
    });
  }, [intent, ready, router]);

  return null;
}
