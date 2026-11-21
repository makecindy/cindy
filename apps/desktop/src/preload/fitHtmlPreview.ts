// A fixed-size page centered in a narrow panel can overflow on both sides.
// scrollWidth alone misses the part that lies to the left of the viewport.
export function installHtmlPreviewFit(): void {
  if (location.protocol !== 'file:' || !/\.html?$/i.test(location.pathname)) return;

  let frame = 0;
  let appliedZoom = '';

  function fit() {
    frame = 0;
    const root = document.documentElement;
    const body = document.body;
    if (!body || !root.clientWidth || body.style.zoom !== appliedZoom) return;

    // Measure at the authored scale, even after the sidebar has been widened.
    if (appliedZoom) body.style.removeProperty('zoom');
    appliedZoom = '';
    const style = getComputedStyle(body);
    if (Number(style.zoom) !== 1) return;

    const viewport = root.clientWidth;
    if (root.scrollWidth <= viewport) return;

    const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
      parseFloat(style.marginLeft) + parseFloat(style.marginRight);
    let width = root.scrollWidth;
    for (const child of body.children) {
      const bounds = child.getBoundingClientRect();
      if (bounds.width + inset <= width) continue;
      const position = getComputedStyle(child).position;
      if (position !== 'absolute' && position !== 'fixed') width = bounds.width + inset;
    }
    body.style.zoom = String(viewport / width);
    appliedZoom = body.style.zoom;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }
  window.addEventListener('load', schedule, { once: true });
  window.addEventListener('resize', schedule);
}
