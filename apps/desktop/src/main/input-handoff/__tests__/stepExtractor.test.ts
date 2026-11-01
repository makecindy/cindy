import { describe, expect, it } from 'vitest';
import { contentTypeFor, extractStep } from '../stepExtractor.js';
import { classifyOrigin } from '../originPolicy.js';
import type { NativeAxNode, NativeAxSnapshot } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref,
  role,
  depth: ref.split('.').length,
  fp: `${role}|${extra.title ?? extra.desc ?? ''}`,
  enabled: true,
  frame: [100, 100, 200, 30],
  ...extra,
});

const snapshot = (nodes: NativeAxNode[], extra: Partial<NativeAxSnapshot> = {}): NativeAxSnapshot => ({
  pid: 42,
  app: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  frontmost: true,
  window: { index: 0, title: 'Sign in', frame: [0, 0, 1200, 900] },
  nodes,
  ...extra,
});

describe('extractStep', () => {
  it('never asks for a browser\'s address bar when its page cannot be read', () => {
    for (const [desc, placeholder] of [['地址和搜索栏', '问问 Google 或输入网址'], ['Address and search bar', 'Search Google or type a URL']]) {
      const step = extractStep(snapshot([node('0', 'AXTextField', { desc, placeholder, hasValue: true, frame: [40, 10, 600, 20] })]));
      expect(step).toMatchObject({ shown: [], controls: [], pageMissing: true });
    }
  });

  it('keeps every control of a native window, which has no page to wait for', () => {
    const step = extractStep(snapshot([node('0', 'AXTextField', { title: 'Email' })], { app: 'Notes', bundleId: 'com.example.notes' }));
    expect(step.shown).toHaveLength(1);
    expect(step.pageMissing).toBeUndefined();
  });

  it('scopes a browser window to the page and maps a login form to standard fields', () => {
    const step = extractStep(snapshot([
      node('0', 'AXButton', { desc: 'Reload', frame: [10, 10, 20, 20] }),
      node('1', 'AXTextField', { desc: 'Address and search bar', frame: [40, 10, 600, 20] }),
      node('2', 'AXWebArea', { url: 'https://accounts.example.com/signin?x=1', frame: [0, 60, 1200, 840] }),
      node('2.0', 'AXHeading', { title: 'Sign in', frame: [100, 80, 300, 30] }),
      node('2.1', 'AXStaticText', { value: 'Email', frame: [100, 130, 60, 18] }),
      node('2.2', 'AXTextField', { frame: [100, 150, 300, 30], hasValue: false }),
      node('2.3', 'AXTextField', { subrole: 'AXSecureTextField', secure: true, title: 'Password', frame: [100, 200, 300, 30] }),
      node('2.4', 'AXLink', { title: 'Forgot password?', frame: [100, 240, 120, 18] }),
      node('2.5', 'AXButton', { title: 'Next', frame: [300, 280, 100, 30] }),
    ]));
    expect(step.source).toEqual({ app: 'Google Chrome', window: 'Sign in', origin: 'https://accounts.example.com' });
    const interactive = step.controls.filter((control) => control.kind !== 'note');
    expect(interactive.map((control) => [control.kind, control.label])).toEqual([
      ['text', 'Email'],
      ['text', 'Password'],
      ['button', 'Forgot password?'],
      ['button', 'Next'],
    ]);
    const [account, password, forgot, next] = interactive as any[];
    expect(account.contentType).toBe('username');
    expect(password.contentType).toBe('password');
    expect(forgot.link).toBe(true);
    expect(next.primary).toBe(true);
    expect(step.controls[0]).toEqual({ id: expect.any(String), kind: 'note', tone: 'heading', text: 'Sign in' });
    expect(step.hasSecure).toBe(true);
    expect(step.bindings.get(password.id)).toEqual({ kind: 'text', ref: '2.3', fp: expect.any(String), secure: true });
    expect(JSON.stringify(step.controls)).not.toContain('Address and search bar');
    // The owner sees only the fields to type.
    expect(step.shown.map((control) => control.kind === 'text' && control.label)).toEqual(['Email', 'Password']);
  });

  it('reads a native app choice screen but shows the owner nothing on it', () => {
    const step = extractStep(snapshot([
      node('0', 'AXButton', { subrole: 'AXCloseButton', desc: 'close' }),
      node('1', 'AXRadioGroup', { desc: 'Login method' }),
      node('1.0', 'AXRadioButton', { title: 'Personal', checked: true }),
      node('1.1', 'AXRadioButton', { title: 'Enterprise SSO', checked: false }),
      node('2', 'AXPopUpButton', { title: 'Region', value: 'Global', options: ['Global', 'China'] }),
      node('3', 'AXCheckBox', { title: 'Remember me', checked: false }),
      node('4', 'AXButton', { title: 'Continue' }),
    ], { app: 'Cindy', bundleId: 'com.example.cindy' }));
    expect(step.source.origin).toBeUndefined();
    expect(step.controls.map((control) => control.kind)).toEqual(['choice', 'choice', 'toggle', 'button']);
    const [method, region, remember] = step.controls as any[];
    expect(method).toMatchObject({ label: 'Login method', selected: 'o0', options: [{ id: 'o0', label: 'Personal' }, { id: 'o1', label: 'Enterprise SSO' }] });
    expect(region).toMatchObject({ label: 'Region', selected: 'o0' });
    expect(remember).toMatchObject({ checked: false });
    // Options and buttons are the agent's: no field means nothing for the owner.
    expect(step.shown).toEqual([]);
    expect(step.bindings.get(method.id)).toBeUndefined();
  });

  it('ignores hidden nodes and app content web areas keep no origin', () => {
    const step = extractStep(snapshot([
      node('0', 'AXWebArea', { url: 'file:///Applications/App.app/index.html', frame: [0, 0, 1200, 900] }),
      node('0.0', 'AXTextField', { title: 'Org code', frame: [0, 0, 1, 0] }),
      node('0.1', 'AXTextField', { title: 'Organization', frame: [10, 10, 200, 30] }),
    ], { app: 'App', bundleId: 'com.example.app' }));
    expect(step.controls.map((control: any) => control.label)).toEqual(['Organization']);
    expect(step.source.origin).toBeUndefined();
  });

  it('reports filled fields without values and keeps signatures stable', () => {
    const nodes = [node('0', 'AXTextField', { title: 'Name', hasValue: true }), node('1', 'AXButton', { title: 'Save' })];
    const a = extractStep(snapshot(nodes, { bundleId: 'x' }));
    const b = extractStep(snapshot(nodes, { bundleId: 'x' }));
    expect(a.controls[0]).toMatchObject({ kind: 'text', filled: true });
    expect(a.signature).toBe(b.signature);
  });

  it('caps crowded screens but keeps inputs and the primary action', () => {
    const nodes: NativeAxNode[] = [];
    for (let i = 0; i < 60; i++) nodes.push(node(String(i), 'AXLink', { title: `Footer ${i}`, frame: [10, 10 + i, 50, 10] }));
    nodes.push(node('60', 'AXTextField', { title: 'Code', frame: [10, 700, 100, 30] }));
    nodes.push(node('61', 'AXButton', { title: 'Verify', frame: [10, 740, 100, 30] }));
    const step = extractStep(snapshot(nodes, { bundleId: 'x' }));
    expect(step.controls.length).toBeLessThanOrEqual(40);
    expect(step.controls.some((control) => control.kind === 'text' && control.contentType === 'one-time-code')).toBe(false);
    expect(step.controls.some((control) => control.kind === 'text' && control.label === 'Code')).toBe(true);
    expect(step.controls.some((control) => control.kind === 'button' && control.primary)).toBe(true);
    expect(step.bindings.size).toBe(step.controls.filter((control) => control.kind !== 'note').length);
  });

  it('turns alert text into error notes', () => {
    const step = extractStep(snapshot([
      node('0', 'AXStaticText', { value: 'Wrong password', alert: true }),
      node('1', 'AXTextField', { secure: true, title: 'Password' }),
    ], { bundleId: 'x' }));
    expect(step.controls[0]).toMatchObject({ kind: 'note', tone: 'error', text: 'Wrong password' });
    expect(step.shown.map((control) => control.kind)).toEqual(['note', 'text']);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['验证码', 'one-time-code'],
    ['Enter the 6-digit verification code', 'one-time-code'],
    ['Enter your 6-digit code', 'one-time-code'],
    ['Enter the 5-digit ZIP code', 'text'],
    ['Last 4 digits of your card', 'text'],
    ['邮箱', 'email'],
    ['手机号', 'tel'],
    ['用户名', 'username'],
    ['Company website URL', 'url'],
    ['Organization code', 'text'],
  ])('%s → %s', (label, expected) => {
    expect(contentTypeFor({ ref: '0', role: 'AXTextField', depth: 1, fp: '' }, label)).toBe(expected);
  });
});

describe('classifyOrigin', () => {
  it.each([
    ['https://login.example.com/a', true, { origin: 'https://login.example.com' }],
    ['http://login.example.com/a', true, { origin: 'http://login.example.com', warning: 'insecure' }],
    ['http://127.0.0.1:8080/', true, { origin: 'http://127.0.0.1:8080', warning: 'local-host' }],
    ['https://10.0.0.3/login', true, { origin: 'https://10.0.0.3', warning: 'ip-address' }],
    ['https://xn--pple-43d.com/', true, { origin: 'https://xn--pple-43d.com', warning: 'punycode' }],
    ['file:///tmp/a.html', true, { origin: 'file://', warning: 'local-file' }],
    ['file:///tmp/a.html', false, {}],
    ['app://index.html', false, {}],
  ])('%s', (url, browser, expected) => {
    expect(classifyOrigin(url, browser)).toEqual(expected);
  });
});
