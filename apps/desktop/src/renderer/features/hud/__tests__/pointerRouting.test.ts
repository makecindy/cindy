// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { getHudPointerRegion } from '../useHudPointerRouting';
afterEach(() => {
  document.body.innerHTML = '';
});
// Unit: production hit testing. Distinguishes real message contents from row whitespace
// and portals, which native IPC tests cannot represent. No OS input or private content.
it('keeps blank space beside a sent message in the background region', () => {
  document.body.innerHTML =
    '<div class="hud-mode wallpaper-message-viewport"><div data-render-item-key="u"><div data-hud-pointer-region="userMessages"><span>Sent</span></div></div></div>';
  expect(getHudPointerRegion(document.querySelector('span'))).toBe('userMessages');
  expect(getHudPointerRegion(document.querySelector('[data-render-item-key]'))).toBe('background');
});
it('retains composer menus and settings even when message regions pass through', () => {
  document.body.innerHTML =
    '<div class="hud-mode"><div data-chat-input-root><button>Send</button></div><div class="hud-settings-overlay"><input /></div></div><div data-radix-popper-content-wrapper><button id="model">Model</button></div>';
  expect(getHudPointerRegion(document.querySelector('[data-chat-input-root] button'))).toBe(
    'composer',
  );
  expect(getHudPointerRegion(document.querySelector('input'))).toBe('controls');
  expect(getHudPointerRegion(document.getElementById('model'))).toBe('controls');
});
it('distinguishes assistant content, tool groups, background and native controls', () => {
  document.body.innerHTML =
    '<div class="hud-chrome"><button>Recover</button></div><div class="hud-mode wallpaper-message-viewport"><p data-hud-pointer-region="assistantMessages">Reply</p><div data-render-item-key="tool"><button>Tool</button></div></div>';
  expect(getHudPointerRegion(document.querySelector('p'))).toBe('assistantMessages');
  expect(getHudPointerRegion(document.querySelector('[data-render-item-key] button'))).toBe(
    'assistantMessages',
  );
  expect(getHudPointerRegion(document.querySelector('.hud-mode'))).toBe('background');
  expect(getHudPointerRegion(document.querySelector('.hud-chrome button'))).toBe('controls');
  expect(getHudPointerRegion(null)).toBe('controls');
});
