// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { applyPhoneViewportLayout, fitPhoneViewport } from '../previewViewportLayout';

describe('fitPhoneViewport', () => {
  const phone = { width: 402, height: 786 };

  it('gives the phone size when it fits, so the page lays out in the phone\'s own CSS px', () => {
    expect(fitPhoneViewport({ width: 900, height: 1000 }, phone)).toEqual(phone);
  });

  it('scales down to fit the box and keeps the shape, in whole px', () => {
    // The side panel is wider than it is tall: bars left and right.
    const size = fitPhoneViewport({ width: 480, height: 600 }, phone)!;
    expect(size.height).toBe(600);
    expect(Math.abs(size.width / size.height - 402 / 786)).toBeLessThan(0.002);
    expect(Number.isInteger(size.width)).toBe(true);
    // Narrow and tall: bars top and bottom.
    const narrow = fitPhoneViewport({ width: 300, height: 900 }, phone)!;
    expect(narrow.width).toBe(300);
    expect(Math.abs(narrow.width / narrow.height - 402 / 786)).toBeLessThan(0.004);
  });

  it('has nothing to fit into an empty box', () => {
    expect(fitPhoneViewport({ width: 0, height: 500 }, phone)).toBeNull();
    expect(fitPhoneViewport({ width: 500, height: 500 }, { width: 0, height: 5 })).toBeNull();
  });
});

describe('applyPhoneViewportLayout', () => {
  function pair(box: { width: number; height: number }) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('style', 'position:relative;width:100%;height:100%;display:flex;');
    const webview = document.createElement('div');
    webview.setAttribute('style', 'flex:1;width:100%;height:100%;');
    Object.defineProperty(wrapper, 'clientWidth', { value: box.width, configurable: true });
    Object.defineProperty(wrapper, 'clientHeight', { value: box.height, configurable: true });
    return { wrapper, webview };
  }

  it('sizes the webview in the phone shape and centres it, then restores both styles exactly', () => {
    const { wrapper, webview } = pair({ width: 480, height: 600 });
    const wrapperBefore = wrapper.getAttribute('style');
    const webviewBefore = webview.getAttribute('style');

    const restore = applyPhoneViewportLayout(wrapper, webview, { width: 402, height: 786 });
    expect(webview.style.height).toBe('600px');
    expect(webview.style.flex).toBe('0 0 auto');
    expect(wrapper.style.justifyContent).toBe('center');
    expect(wrapper.style.alignItems).toBe('center');

    restore();
    expect(wrapper.getAttribute('style')).toBe(wrapperBefore);
    expect(webview.getAttribute('style')).toBe(webviewBefore);
    restore();
    expect(webview.getAttribute('style')).toBe(webviewBefore);
  });

  it('removes a style attribute that was not there before', () => {
    const wrapper = document.createElement('div');
    const webview = document.createElement('div');
    Object.defineProperty(wrapper, 'clientWidth', { value: 500 });
    Object.defineProperty(wrapper, 'clientHeight', { value: 800 });
    applyPhoneViewportLayout(wrapper, webview, { width: 402, height: 786 })();
    expect(wrapper.hasAttribute('style')).toBe(false);
    expect(webview.hasAttribute('style')).toBe(false);
  });
});
