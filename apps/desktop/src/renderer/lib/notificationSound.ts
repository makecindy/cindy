/**
 * notificationSound — 系统通知的应用级提示音(#3177)
 * ---------------------------------------------------------------------------
 * 跨平台本地声音通道:Windows/Linux 上 OS 通知音可能被勿扰/专注助手吞掉,
 * macOS 无灵动岛时同样没有应用可控的声音。这里用与灵动岛内置音效同源的
 * 资产(gem-collect / error-buzz / secret-chime,见 native/agent-island/sounds/)
 * 和同一套事件语义(done→complete 音,error→error 音,needs-reply→attention 音),
 * 由 renderer 直接 new Audio 播放——不依赖 macOS 原生岛,失败静默降级。
 *
 * 触发口径:只在 notificationService 的裁决点(CC Agent session 事件)调用;
 * 不在权限回调、确认卡组件里散播播放调用(维护者 review 边界)。
 */

import completeSoundUrl from '@/assets/sounds/gem-collect.mp3';
import errorSoundUrl from '@/assets/sounds/error-buzz.mp3';
import attentionSoundUrl from '@/assets/sounds/secret-chime.mp3';

import { createLogger } from '@/lib/logger';

const log = createLogger('NotificationSound');

export type SessionNotificationSoundKind = 'done' | 'error' | 'needs-reply';

const SOUND_URL_BY_KIND: Record<SessionNotificationSoundKind, string> = {
  done: completeSoundUrl,
  error: errorSoundUrl,
  'needs-reply': attentionSoundUrl,
};

/**
 * 播放一次会话事件提示音。任何失败(自动播放策略、资源缺失、解码错误)都
 * 静默降级——声音是锦上添花,不能影响通知本体与审批流程。
 */
export function playSessionEventSound(kind: SessionNotificationSoundKind): void {
  try {
    const audio = new Audio(SOUND_URL_BY_KIND[kind]);
    // toast 本体已发出;播放失败只留 debug 级痕迹,不抛出。
    void audio.play().catch(() => {
      /* autoplay blocked or device muted — silent degrade */
    });
  } catch (err) {
    log.debug('notification sound skipped', err);
  }
}
