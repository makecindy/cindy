export type MarkdownPageDirection = 'previous' | 'next';

export function parseMarkdownPageSwipe(data: string): MarkdownPageDirection | null {
  if (data === 'markdown-page:previous') return 'previous';
  if (data === 'markdown-page:next') return 'next';
  return null;
}

/**
 * Classify inside the document, where the touched scroll container is known.
 * Passive listeners leave vertical scrolling, formula panning and selection native.
 * The host receives only a completed page swipe, never document content.
 */
export const MARKDOWN_FILE_PAGER_SCRIPT = `
(function () {
  if (window.__cindyMarkdownPager) return;
  window.__cindyMarkdownPager = true;
  var gesture = null;
  function selected() {
    var selection = window.getSelection();
    return selection && !selection.isCollapsed;
  }
  function ownsHorizontalPan(target) {
    var element = target && (target.nodeType === 1 ? target : target.parentElement);
    while (element && element !== document.body) {
      if (element.tagName === 'A') return true;
      var overflow = window.getComputedStyle(element).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') &&
          element.scrollWidth > element.clientWidth + 1) return true;
      element = element.parentElement;
    }
    return false;
  }
  function move(touch, time) {
    if (!gesture || touch.identifier !== gesture.id) return;
    var dx = touch.clientX - gesture.x;
    var dy = touch.clientY - gesture.y;
    if (!gesture.horizontal) {
      // Once vertical reading or a long press wins, this touch cannot turn into paging.
      if (Math.abs(dy) > 8 || time - gesture.time > 500) {
        gesture = null;
        return;
      }
      if (Math.abs(dx) > 16) gesture.horizontal = true;
    }
  }
  document.addEventListener('touchstart', function (event) {
    gesture = null;
    if (event.touches.length !== 1 || selected() || ownsHorizontalPan(event.target)) return;
    var touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
      time: event.timeStamp, horizontal: false };
  }, { passive: true });
  document.addEventListener('touchmove', function (event) {
    if (event.touches.length !== 1 || selected()) { gesture = null; return; }
    move(event.touches[0], event.timeStamp);
  }, { passive: true });
  document.addEventListener('touchcancel', function () { gesture = null; }, { passive: true });
  document.addEventListener('touchend', function (event) {
    if (!gesture || event.touches.length || event.changedTouches.length !== 1) {
      gesture = null;
      return;
    }
    var touch = event.changedTouches[0];
    if (touch.identifier !== gesture.id) { gesture = null; return; }
    move(touch, event.timeStamp);
    var ended = gesture;
    gesture = null;
    if (!ended || !ended.horizontal || selected()) return;
    var dx = touch.clientX - ended.x;
    var dy = touch.clientY - ended.y;
    var velocity = Math.abs(dx) * 1000 / Math.max(1, event.timeStamp - ended.time);
    if (Math.abs(dy) > Math.abs(dx) / 2 || (Math.abs(dx) < 56 && velocity < 500)) return;
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(dx < 0 ? 'markdown-page:next' : 'markdown-page:previous');
    }
  }, { passive: true });
})();
true;
`;
