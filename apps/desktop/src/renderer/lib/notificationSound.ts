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

/** Local assets should start immediately; fall back to the OS sound instead of blocking alerts. */
export const NOTIFICATION_SOUND_START_TIMEOUT_MS = 500;

/**
 * 同类终态提示音的冷却窗口(#3257 review P1):并发完成的多个任务会在同一批
 * 状态更新里各自触发 fireSessionNotification,不设冷却时多个相同 mp3 会叠加
 * 失真。与灵动岛同语义路径的每类 1.5s 冷却保持一致(service.ts:1364-1370)。
 */
export const SESSION_SOUND_COOLDOWN_MS = 1_500;

const lastPlayedAtByKind = new Map<SessionNotificationSoundKind, number>();

/** 仅供测试:模块级冷却 Map 会跨用例残留,用例间用它清零。 */
export function resetNotificationSoundCooldownForTest(): void {
  lastPlayedAtByKind.clear();
}

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
  signal?: AbortSignal,
): Promise<boolean> {
  // 冷却合并:刚为同类事件成功播过一声,本次视为已被覆盖——返回 true 让
  // 调用方照常静音其 toast(用户毫秒级前刚听过同一个音,不需要 OS 音再补)。
  // 只统计成功播放:上次失败不进入冷却,下次事件仍会重试(review P1 场景)。
  const now = Date.now();
  const lastPlayedAt = lastPlayedAtByKind.get(kind) ?? 0;
  if (now - lastPlayedAt < SESSION_SOUND_COOLDOWN_MS) {
    return true;
  }
  const audio = new Audio(SOUND_URL_BY_KIND[kind]);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  let audioStopped = false;
  const stopAudio = (): void => {
    if (audioStopped) return;
    audioStopped = true;
    audio.pause();
  };
  try {
    if (signal?.aborted) return false;
    // play() resolve 表示实际开始出声;资源加载/解码失败与 autoplay 拒绝都会 reject。
    const startupResults: Array<Promise<boolean>> = [
      audio.play().then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), NOTIFICATION_SOUND_START_TIMEOUT_MS);
      }),
    ];
    if (signal) {
      startupResults.push(
        new Promise<boolean>((resolve) => {
          abortListener = () => {
            stopAudio();
            resolve(false);
          };
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      );
    }
    const started = await Promise.race(startupResults);
    if (!started) {
      // play() 没有取消 API；pause 阻止超时后迟到的 resolve 再补播一声。
      stopAudio();
      log.debug(
        signal?.aborted
          ? 'notification sound cancelled after window focus'
          : 'notification sound startup timed out',
      );
      return false;
    }
    // 只有真实开始播放才进入冷却;超时/中止的失败不占用冷却窗口。
    lastPlayedAtByKind.set(kind, Date.now());
    return started;
  } catch (err) {
    stopAudio();
    log.debug('notification sound skipped', err);
    return false;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
