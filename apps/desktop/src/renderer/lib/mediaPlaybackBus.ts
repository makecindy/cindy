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

/** 已脱离页面的播放器 pause 后仍可能留着解码管线；只清这类元素的源。 */
function releaseDetachedPipeline(el: HTMLMediaElement): void {
  if (el.isConnected) return;
  const sources = Array.from(el.querySelectorAll('source'));
  const hasSource = (el.srcObject !== null && el.srcObject !== undefined)
    || el.hasAttribute('src')
    || sources.some((source) => source.hasAttribute('src'));
  // 浮层自己可能已先释放；不要在 effect cleanup 里重复 load、重置同一媒体。
  if (!hasSource) return;
  try {
    el.srcObject = null;
  } catch {
    /* 已脱离文档或浏览器不接受清空 */
  }
  el.removeAttribute('src');
  for (const source of sources) source.removeAttribute('src');
  try {
    el.load();
  } catch {
    /* 销毁中的元素可能没有 load */
  }
}

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
    // 无条件 pause 涵盖 play() pending、paused 仍为 true 的窗口。
    // 仍挂载的元素保留源供 effect replay；脱离页面的元素释放解码管线。
    try {
      el.pause();
    } catch {
      /* 元素已 detach / 销毁中 — 静默 */
    }
    releaseDetachedPipeline(el);
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
