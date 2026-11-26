/**
 * mediaPlaybackBus
 * ---------------------------------------------------------------------------
 * 聊天流里所有 <audio> / <video> 的全局互斥总线。两条规则:
 *   1. 同一时刻只允许一个媒体元素在播放——新的 play 事件触发时,自动
 *      pause 其它所有已注册的元素。
 *   2. 切 session 时调用 stopAllMedia() 把当前 session 仍在播放的媒体
 *      显式停掉(由 MessageStream 顶层 useEffect cleanup 触发)。
 *
 * 用法:
 *   useEffect(() => {
 *     const el = mediaRef.current;
 *     if (!el) return;
 *     return registerMedia(el);   // 返回 cleanup
 *   }, []);
 *
 * 设计要点:
 *   - 监听元素自身的 `play` 事件,而不是包一层 togglePlay() 之类的方法。
 *     这样无论谁触发播放(自定义按钮 / 原生 controls / autoPlay /
 *     element.play())都能命中互斥。
 *   - pause() 是同步的,不返回 Promise(只有 play() 返 Promise),所以
 *     这里不需要 await。
 *   - 不调 onpause / onended 反向更新状态——pause() 会自然派发 pause
 *     事件,各组件已经各自监听了 pause/ended 来收敛 UI。
 */

const registered = new Set<HTMLMediaElement>();

function pauseOthers(active: HTMLMediaElement): void {
  for (const el of registered) {
    if (el === active) continue;
    if (!el.paused) {
      try {
        el.pause();
      } catch {
        /* 元素已 detach / 销毁中 — 静默 */
      }
    }
  }
}

/**
 * 释放已经脱离页面的元素的媒体管线。
 *
 * cleanup 可能发生在 React 已经把元素移出 DOM 之后。此时元素不在总线上,
 * stopAllMedia() 找不到它,Chromium 仍可能继续解码音频。清掉源再 load() 能让
 * 管线释放。仍挂在页面上的元素不处理:React 重放 effect 时会再次注册同一个
 * 元素,它需要保留源才能重新播放。
 */
function releaseDetachedMedia(el: HTMLMediaElement): void {
  if (el.isConnected) return;
  const sources = Array.from(el.querySelectorAll('source[src]'));
  // A preview can release its source before the close animation unmounts it.
  // Running load() again would reset the already-released player.
  if (!el.srcObject && !el.hasAttribute('src') && sources.length === 0) return;
  try {
    el.srcObject = null;
    el.removeAttribute('src');
    for (const source of sources) source.removeAttribute('src');
    el.load();
  } catch {
    /* 元素正在被页面销毁 — 静默 */
  }
}

/**
 * 注册一个媒体元素到互斥总线。返回 cleanup,必须在 effect cleanup 里调用。
 * 多次注册同一个元素是幂等的(Set 去重 + 同一 listener 重复 add 在
 * 浏览器层也只会挂一份,但稳妥起见 cleanup 逻辑仍按对称形式写)。
 */
export function registerMedia(el: HTMLMediaElement): () => void {
  const onPlay = (): void => {
    pauseOthers(el);
  };
  registered.add(el);
  el.addEventListener('play', onPlay);
  return () => {
    // Stop playback (including a pending play()) while we still own the player.
    el.pause();
    // A detached element leaves the bus with this call, so stopAllMedia() can
    // never reach it again; release its pipeline here instead.
    releaseDetachedMedia(el);
    el.removeEventListener('play', onPlay);
    registered.delete(el);
  };
}

/**
 * 停止所有已注册的媒体元素。由 MessageStream 在 session 切换 / unmount
 * 时调用,作为 React unmount 的兜底——元素从 DOM 移除通常会自动停止
 * 播放,但 chromium 偶发存在短暂延迟,显式 pause 能保证即时停止。
 */
export function stopAllMedia(): void {
  for (const el of registered) {
    if (!el.paused) {
      try {
        el.pause();
      } catch {
        /* 元素已 detach — 静默 */
      }
    }
  }
}

/** 测试用:清空注册表(不在生产路径使用)。 */
export function __resetMediaBusForTests(): void {
  registered.clear();
}
