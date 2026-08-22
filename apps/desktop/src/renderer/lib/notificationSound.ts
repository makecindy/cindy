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
 * 播放一次会话事件提示音,返回是否真的开始播放。
 *
 * 返回值驱动调用方决定是否把系统 toast 置静音(review P2):
 *   - true  = play() 已 resolve(实际出声)→ 调用方静音 OS 通知音,单一声源;
 *   - false = 自动播放被策略拒绝 / 资源缺失或解码失败 → 调用方保持 Electron
 *             默认(silent:false),OS 通知音照常,用户至少还有一条可听的提醒。
 */
export async function playSessionEventSound(
  kind: SessionNotificationSoundKind,
): Promise<boolean> {
  try {
    const audio = new Audio(SOUND_URL_BY_KIND[kind]);
    // play() resolve 表示实际开始出声;资源加载/解码失败与 autoplay 拒绝都会 reject。
    await audio.play();
    return true;
  } catch (err) {
    log.debug('notification sound skipped', err);
    return false;
  }
}
