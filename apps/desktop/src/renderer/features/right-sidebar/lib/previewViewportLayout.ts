export interface ViewportBox {
  width: number;
  height: number;
}

/**
 * The size a cast tab's `<webview>` gets inside `box` so that it has the phone's picture shape:
 * the phone's own size when it fits, otherwise scaled down to fit with the shape kept. Never
 * larger than the phone's size (a bigger panel leaves bars instead of changing the layout
 * the page is given), whole pixels, at least 1.
 */
export function fitPhoneViewport(box: ViewportBox, phone: ViewportBox): ViewportBox | null {
  if (!(box.width > 0 && box.height > 0 && phone.width > 0 && phone.height > 0)) return null;
  const scale = Math.min(1, box.width / phone.width, box.height / phone.height);
  return {
    width: Math.max(1, Math.floor(phone.width * scale)),
    height: Math.max(1, Math.floor(phone.height * scale)),
  };
}

/**
 * Lays the pool wrapper's `<webview>` out in the phone's shape, centred in the wrapper, and
 * follows the wrapper's size. Only inline styles of the two elements are touched, and
 * the returned function puts back exactly the attribute values found. The DOM position is not
 * changed (moving a `<webview>` would rebuild its guest). It holds identically whether the tab
 * is on screen or in the invisible keep-alive layer, so the captured picture has the phone's
 * shape in both.
 */
export function applyPhoneViewportLayout(
  wrapper: HTMLElement,
  webview: HTMLElement,
  phone: ViewportBox,
): () => void {
  const wrapperStyle = wrapper.getAttribute('style');
  const webviewStyle = webview.getAttribute('style');
  const apply = () => {
    const size = fitPhoneViewport(
      { width: wrapper.clientWidth, height: wrapper.clientHeight },
      phone,
    );
    if (!size) return;
    wrapper.style.justifyContent = 'center';
    wrapper.style.alignItems = 'center';
    webview.style.flex = 'none';
    webview.style.width = `${size.width}px`;
    webview.style.height = `${size.height}px`;
  };
  apply();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
  observer?.observe(wrapper);
  return () => {
    observer?.disconnect();
    restoreAttribute(wrapper, 'style', wrapperStyle);
    restoreAttribute(webview, 'style', webviewStyle);
  };
}

function restoreAttribute(el: HTMLElement, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}
