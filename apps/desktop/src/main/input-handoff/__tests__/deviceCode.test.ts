import { describe, expect, it } from 'vitest';
import { isInputHandoffDeviceCode } from '@cindy/device-link';
import { extractStep } from '../stepExtractor.js';
import type { NativeAxNode, NativeAxSnapshot } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref,
  role,
  depth: ref.split('.').length,
  fp: `${role}|${extra.title ?? extra.desc ?? extra.value ?? ''}`,
  enabled: true,
  frame: [100, 100, 200, 30],
  ...extra,
});

const snapshot = (nodes: NativeAxNode[], app = 'Code'): NativeAxSnapshot => ({
  pid: 42,
  app,
  bundleId: app === 'Code' ? 'com.microsoft.VSCode' : 'com.google.Chrome',
  frontmost: true,
  window: { index: 0, title: 'Sign in', frame: [0, 0, 1200, 900] },
  nodes,
});

describe('device-code sign-in', () => {
  it('finds a code and a link written into one sentence of a native dialog', () => {
    const step = extractStep(snapshot([
      node('0', 'AXStaticText', { value: 'Enter code WDJB-MJHT at github.com/login/device to sign in.' }),
      node('1', 'AXButton', { title: 'Copy & Continue' }),
      node('2', 'AXButton', { title: 'Cancel' }),
    ]));
    expect(step.deviceCode).toEqual({
      code: 'WDJB-MJHT',
      url: 'https://github.com/login/device',
      origin: 'https://github.com',
    });
  });

  it('finds a code shown on its own and the page link it points to', () => {
    const step = extractStep(snapshot([
      node('0', 'AXWebArea', { url: 'https://login.example.com/device/start', frame: [0, 60, 1200, 840] }),
      node('0.0', 'AXHeading', { title: 'Sign in on another device', frame: [100, 80, 300, 30] }),
      node('0.1', 'AXStaticText', { value: 'F3QWE9R2L', frame: [100, 130, 200, 30] }),
      node('0.2', 'AXLink', { title: 'Open the sign-in page', url: 'https://microsoft.com/devicelogin', frame: [100, 180, 200, 18] }),
    ], 'Google Chrome'));
    expect(step.deviceCode).toEqual({
      code: 'F3QWE9R2L',
      url: 'https://microsoft.com/devicelogin',
      origin: 'https://microsoft.com',
    });
  });

  it('stays an ordinary step when anything is to be typed or the shape is ambiguous', () => {
    const typed = extractStep(snapshot([
      node('0', 'AXStaticText', { value: 'Enter code WDJB-MJHT at github.com/login/device' }),
      node('1', 'AXTextField', { title: 'Code' }),
    ]));
    expect(typed.deviceCode).toBeUndefined();
    const twoCodes = extractStep(snapshot([
      node('0', 'AXStaticText', { value: 'Codes WDJB-MJHT and QQRT-77AB at github.com/login/device' }),
    ]));
    expect(twoCodes.deviceCode).toBeUndefined();
    const noLink = extractStep(snapshot([node('0', 'AXStaticText', { value: 'Your code is WDJB-MJHT' })]));
    expect(noLink.deviceCode).toBeUndefined();
    const phone = extractStep(snapshot([
      node('0', 'AXStaticText', { value: 'Call 400-820-8820 or visit example.com/help' }),
    ]));
    expect(phone.deviceCode).toBeUndefined();
  });

  it('never offers a link that is not plain public https', () => {
    for (const link of [
      'http://github.com/login/device',
      'https://user:pw@github.com/login/device',
      'https://192.168.1.2/device',
      'https://xn--gthub-zsa.com/login/device',
      'javascript:alert(1)',
    ]) {
      const step = extractStep(snapshot([
        node('0', 'AXStaticText', { value: 'WDJB-MJHT' }),
        node('1', 'AXLink', { title: 'Open', url: link }),
      ]));
      expect(step.deviceCode, link).toBeUndefined();
    }
  });

  it('the shared check rejects anything a client should not open', () => {
    const ok = { code: 'WDJB-MJHT', url: 'https://github.com/login/device', origin: 'https://github.com' };
    expect(isInputHandoffDeviceCode(ok)).toBe(true);
    expect(isInputHandoffDeviceCode({ ...ok, origin: 'https://evil.example' })).toBe(false);
    expect(isInputHandoffDeviceCode({ ...ok, url: 'http://github.com/login/device', origin: 'http://github.com' })).toBe(false);
    expect(isInputHandoffDeviceCode({ ...ok, code: 'wdjb mjht' })).toBe(false);
    expect(isInputHandoffDeviceCode({ ...ok, extra: 1 })).toBe(false);
    expect(isInputHandoffDeviceCode(undefined)).toBe(false);
  });
});
