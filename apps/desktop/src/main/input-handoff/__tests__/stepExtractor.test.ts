import { describe, expect, it } from 'vitest';
import { applyFieldPlan, contentTypeFor, extractStep } from '../stepExtractor.js';
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
  // Long-form regression: extractStep must retain fields below the viewport (unit).
  // Existing crowded-screen coverage only used links, never an offscreen input or >40 inputs.
  it('keeps the complete scrollable web form and its submit action', () => {
    const step = extractStep(snapshot([
      node('0', 'AXWebArea', { url: 'https://example.test/keys', frame: [0, 60, 1200, 840] }),
      node('0.1', 'AXTextField', { title: 'First key' }),
      // Chrome clips offscreen AX rectangles to zero height at the page edge.
      node('0.2', 'AXTextField', { title: 'Last key', frame: [100, 900, 200, 0] }),
      node('0.3', 'AXButton', { title: 'Continue', frame: [100, 900, 200, 0] }),
    ]));
    expect(step.shown.map(c => c.kind === 'text' && c.label)).toEqual(['First key', 'Last key']);
    expect(step.controls.find(c => c.kind === 'button')).toMatchObject({ primary: true });
  });

  // Unit/security regression: offscreen fields are included, so their ancestor
  // origins must be too. A preceding top-level password must not mask the iframe.
  it.each([
    { url: 'https://other.example/login', frame: [100, 1000, 400, 100], warning: 'embedded-frame' },
    { url: 'https://other.example/login', frame: [100, 900, 400, 0], warning: 'embedded-frame' },
    { url: 'https://example.test/nested', frame: [100, 900, 400, 0], warning: undefined },
  ])('retains the origin warning for an offscreen frame: %j', ({ url, frame, warning }) => {
    const step = extractStep(snapshot([
      node('0', 'AXWebArea', { url: 'https://example.test/login', frame: [0, 60, 1200, 840] }),
      node('0.1', 'AXTextField', { title: 'Main password', secure: true }),
      node('0.2', 'AXWebArea', { url, frame }),
      node('0.2.0', 'AXTextField', { title: 'Embedded password', secure: true, frame }),
    ]));
    expect(step.shown.map(c => c.kind === 'text' && c.label)).toEqual(['Main password', 'Embedded password']);
    expect(step.source.origin).toBe('https://example.test');
    expect(step.source.warning).toBe(warning);
  });

  it('never exposes a silently truncated form as a complete step', () => {
    const nodes = Array.from({ length: 41 }, (_, i) => node(String(i), 'AXTextField', { title: `Key ${i}` }));
    for (const input of [snapshot(nodes, { bundleId: 'x' }), snapshot(nodes.slice(0, 2), { bundleId: 'x', truncated: true })]) {
      expect(() => extractStep(input)).toThrow('Incomplete form');
    }
  });

  // Unit/security: an accepted plan can make a plain field a logical password.
  // The final warning must describe that target's frame, including clipped frames.
  it.each([
    { url: 'https://other.example/login', height: 100, warning: 'embedded-frame' },
    { url: 'https://other.example/login', height: 0, warning: 'embedded-frame' },
    { url: 'https://example.test/nested', height: 100, warning: undefined },
  ])('checks a planned password frame origin: %j', ({ url, height, warning }) => {
    const frame = [100, height ? 200 : 900, 400, height];
    const step = extractStep(snapshot([
      node('0', 'AXWebArea', { url: 'https://example.test/login', frame: [0, 60, 1200, 840] }),
      node('0.1', 'AXWebArea', { url, frame }),
      node('0.1.0', 'AXTextField', { title: 'Entry', frame }),
    ]));
    expect(step.source.warning).toBeUndefined();
    expect(applyFieldPlan(step, [{ label: 'Password', contentType: 'password', targets: [{ label: 'Entry' }] }])).toBe(true);
    expect(step.shown[0]).toMatchObject({ contentType: 'password' });
    expect(step.source.origin).toBe('https://example.test');
    expect(step.source.warning).toBe(warning);
  });

  it('never asks for a browser\'s address bar when its page cannot be read', () => {
    for (const [desc, placeholder] of [['地址和搜索栏', '问问 Google 或输入网址'], ['Address and search bar', 'Search Google or type a URL']]) {
      const step = extractStep(snapshot([node('0', 'AXTextField', { desc, placeholder, hasValue: true, frame: [40, 10, 600, 20] })]));
      expect(step).toMatchObject({ shown: [], controls: [], pageMissing: true });
    }
  });

  describe('which steps are a sign-in', () => {
    const page = (url: string, fields: NativeAxNode[], extra: NativeAxNode[] = []) =>
      snapshot([node('0', 'AXWebArea', { url, frame: [0, 60, 1200, 840] }), ...fields, ...extra]);
    const field = (label: string, extra: Partial<NativeAxNode> = {}) => node('0.1', 'AXTextField', { title: label, ...extra });

    it('counts a password or a one-time code on any page, and an account only where the page says it is a sign-in', () => {
      expect(extractStep(page('https://shop.example.com/pay', [field('Password', { secure: true })])).signIn).toBe(true);
      expect(extractStep(page('https://shop.example.com/pay', [field('Verification code')])).signIn).toBe(true);
      expect(extractStep(page('https://appstoreconnect.apple.com/login', [field('Email')])).signIn).toBe(true);
      // Read protection covers web addresses only: no sign-in on the window without it.
      expect(extractStep(page('file:///tmp/login.html', [field('Password', { secure: true })])).signIn).toBeUndefined();
      expect(extractStep(page('https://shop.example.com/pay', [field('Email')], [node('0.0', 'AXHeading', { title: 'Sign in to continue' })])).signIn).toBe(true);
    });

    it('leaves checkout and account-opening forms as forms', () => {
      for (const label of ['Email for receipt', 'Bank account number', 'Accounting code']) {
        expect(extractStep(page('https://shop.example.com/checkout', [field(label)])).signIn).toBeUndefined();
      }
    });

    it('reads login words and addresses as whole words, not pieces of other words', () => {
      const heading = (title: string) => [node('0.0', 'AXHeading', { title })];
      for (const text of ['Design inspiration', 'Catalog information', 'Plugin settings']) {
        expect(extractStep(page('https://shop.example.com/pay', [field('Email')], heading(text))).signIn).toBeUndefined();
      }
      for (const url of ['https://shop.example.com/authors/jane', 'https://shop.example.com/authorize-card', 'https://shop.example.com/accountability']) {
        expect(extractStep(page(url, [field('Email')])).signIn).toBeUndefined();
      }
      for (const url of ['https://login.example.com/', 'https://accounts.example.com/x', 'https://example.com/oauth2/start', 'https://example.com/user/sign-in']) {
        expect(extractStep(page(url, [field('Email')])).signIn).toBe(true);
      }
      expect(extractStep(page('https://shop.example.com/pay', [field('Email')], heading('请先登录'))).signIn).toBe(true);
    });

    it('keeps a browser page whose address is unknown as an ordinary form', () => {
      const noAddress = snapshot([node('0', 'AXWebArea', { frame: [0, 60, 1200, 840] }), field('Password', { secure: true })]);
      expect(extractStep(noAddress).signIn).toBeUndefined();
      // A native window has no page address to cover and no browser read tools to guard.
      expect(extractStep(snapshot([field('Password', { secure: true })], { app: 'Notes', bundleId: 'com.example.notes' })).signIn).toBe(true);
    });
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
    expect(step.bindings.get(password.id)).toMatchObject({ kind: 'text', ref: '2.3', fp: expect.any(String), secure: true });
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

// Unit regression: GitHub-like split code labels previously became eight owner fields.
// Existing extraction tests cover individual inputs, not logical grouping or ambiguous plans.
describe('logical field plans', () => {
  const codeStep = () => extractStep(snapshot([
    node('0', 'AXWebArea', { url: 'https://example.com/device' }),
    ...[0, 1, 2, 3, 5, 6, 7, 8].map((n) => node(`0.${n}`, 'AXTextField', { title: `User code ${n}` })),
  ]));
  const plan = [{ label: '授权码', contentType: 'one-time-code' as const,
    targets: [0, 1, 2, 3, 5, 6, 7, 8].map((n) => ({ label: `User code ${n}`, length: 1 })) }];
  it('shows one code and keeps all eight host bindings in the declared order', () => {
    const step = codeStep();
    expect(applyFieldPlan(step, plan)).toBe(true);
    expect(step.shown).toMatchObject([{ label: '授权码', contentType: 'one-time-code' }]);
    const binding = step.bindings.get(step.shown[0].id);
    expect(binding?.kind === 'text' && binding.segments?.map((s) => s.ref)).toEqual(['0.0','0.1','0.2','0.3','0.5','0.6','0.7','0.8']);
  });
  it('rejects incomplete, duplicate and ambiguous matches without changing the form', () => {
    for (const targets of [plan[0].targets.slice(1), [...plan[0].targets, plan[0].targets[0]], [{ label: 'missing', length: 8 }], plan[0].targets.map(({ label }) => ({ label }))]) {
      const step = codeStep();
      const before = JSON.stringify(step.shown);
      expect(applyFieldPlan(step, [{ ...plan[0], targets }])).toBe(false);
      expect(JSON.stringify(step.shown)).toBe(before);
    }
    const ambiguous = extractStep(snapshot([
      node('0', 'AXTextField', { title: 'Code' }), node('1', 'AXTextField', { title: 'Code' }),
    ], { bundleId: 'com.example.native' }));
    expect(applyFieldPlan(ambiguous, [{ label: 'Code', contentType: 'one-time-code', targets: [{ label: 'Code' }] }])).toBe(false);
    expect(ambiguous.shown).toHaveLength(2);
  });
  it('never downgrades a native password field to ordinary text', () => {
    const step = extractStep(snapshot([node('0', 'AXTextField', { title: 'Password', secure: true })], { bundleId: 'com.example.native' }));
    expect(applyFieldPlan(step, [{ label: '系统密码', contentType: 'text', targets: [{ label: 'Password' }] }])).toBe(true);
    expect(step.shown[0]).toMatchObject({ contentType: 'password' });
  });
});
