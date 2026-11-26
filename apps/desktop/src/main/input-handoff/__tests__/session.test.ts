import { describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffSession, type HandoffResult } from '../session.js';
import type { HandoffDriver } from '../macDriver.js';
import { fakeDesktop } from './fakeDesktop.js';

function harness(driver: HandoffDriver, extra: Partial<ConstructorParameters<typeof InputHandoffSession>[0]> = {}) {
  const published: InputHandoffSnapshot[] = [];
  const finished: HandoffResult[] = [];
  let clock = 0;
  const session = new InputHandoffSession({
    requestId: 'req1',
    purpose: 'Sign in to Example',
    target: { app: 'Example' },
    timeoutMs: 600_000,
    hostPid: 1,
    remoteInput: true,
    driver,
    publish: (snapshot) => published.push(snapshot),
    finish: (result) => finished.push(result),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    finishingDelayMs: 5,
    ...extra,
  });
  const latest = () => published[published.length - 1];
  return { session, published, finished, latest };
}

const field = (step: InputHandoffSnapshot) => step.controls.find((control) => control.kind === 'text')!;

describe('InputHandoffSession', () => {
  // A pay page: a phone field and, under the code prompt, the real code input shrunk to one pixel and focused.
  // Typing moves the focus as native typing does. Layouts after the phone is typed: `insert` adds a line above the
  // code (tree positions shift); `trap` drops a line so a never-focused 1x1 field of the same kind takes the code
  // field's old place; `frame` holds the code in a frame and adds a line above the frame. `staleOnce`: the first
  // native fill of the code reports the element stale, as after a re-render.
  // `fragment`: the code's frame only rewrites its address fragment once the phone is typed. `twoSteps`: confirming
  // moves to a password step on the same address that remounts a never-focused 1x1 field with the code's id.
  // `sameFp`: the phone has no id or title, only a line above naming it, so it shares the code field's fingerprint.
  // `twinFrames`: the code sits in a frame, and a second frame loading the same address holds a never-focused 1x1
  // field with the same id; with `twinDrop`, typing the phone removes the code's frame and leaves the second one.
  // `splitCode`: no phone; a visible first box of the code, then the shrunken focused one, for a field plan joining
  // them. `rejects`: confirming shows a code error and takes the focus off the code; `errorAbove` puts the error right
  // above the code, where it names it. `noIds`: the code fields have no page id, and with `twinDrop` the second frame
  // loads another address. `twinSwap`: typing the phone swaps the two frames; `twinDropOther`: moving the focus off the
  // code removes the second frame. `dupId`: no phone; next to the focused code, a never-focused 1x1 field reads with
  // the same id (ids are read cut off at 64 characters) and fingerprint; `dupIdDrop` has the phone, and typing it
  // removes the focused one. `twinIds`: the two frames' fields have different ids, and a rejected code removes the
  // second frame. `dupIdLate`: the field read alike as `dupId`'s appears only once `state.lateTwin` is set, and typing the
  // phone removes the code. `state.paid`: the code goes, success text shows, and a never-focused 1x1 field remains.
  // `stalePhone`: the first fill of the phone reports it stale and sets `state.lateTwin`. `state.phoneStatic`: the
  // page turns the phone into plain text.
  type PayLayout = 'focus' | 'insert' | 'trap' | 'frame' | 'fragment' | 'twoSteps' | 'sameFp' | 'twinFrames' | 'twinDrop' |
    'twinSwap' | 'twinDropOther' | 'twinIds' | 'splitCode' | 'dupId' | 'dupIdDrop' | 'dupIdLate';
  function payPage(options: { layout?: PayLayout; staleOnce?: boolean; stalePhone?: boolean; rejects?: boolean; errorAbove?: boolean; noIds?: boolean } = {}) {
    const layout = options.layout ?? 'focus';
    const state = { focus: 'code', phoneTyped: false, stale: !!options.staleOnce, secondStep: false, rejected: false, lateTwin: false, paid: false, phoneStatic: false, stalePhone: !!options.stalePhone };
    const acts: Array<{ kind: string; ref?: string }> = [];
    const chrome = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
    const n = (ref: string, role: string, extra: Record<string, unknown> = {}) =>
      ({ ref, role, depth: 1, fp: `${role}|${(extra.title as string) ?? ''}`, enabled: true, ...extra });
    const nodes = () => {
      const out = [n('0', 'AXWebArea', { url: 'https://secure.example.test/pay', frame: [0, 60, 1200, 840] })];
      let i = 0;
      const next = () => `0.${++i}`;
      if (state.secondStep) {
        out.push(n(next(), 'AXTextField', { title: 'Password', secure: true, frame: [460, 300, 260, 30], focused: state.focus === 'password' }));
        out.push(n(next(), 'AXTextField', { domId: 'sms-code', frame: [460, 440, 1, 1] }));
        out.push(n(next(), 'AXButton', { title: '确定', frame: [460, 500, 290, 36] }));
        return out;
      }
      if (layout === 'dupId') {
        // No phone.
      } else if (layout === 'splitCode') {
        out.push(n(next(), 'AXTextField', { title: 'Code 1', frame: [460, 300, 40, 30], focused: state.focus === 'phone' }));
      } else if (layout === 'sameFp') {
        out.push(n(next(), 'AXStaticText', { value: 'Phone', frame: [460, 280, 60, 16] }));
        out.push(n(next(), 'AXTextField', { frame: [460, 300, 260, 30], focused: state.focus === 'phone' }));
      } else if (state.phoneStatic) out.push(n(next(), 'AXStaticText', { value: '186****0000', frame: [460, 300, 260, 30] }));
      else out.push(n(next(), 'AXTextField', { title: 'Phone', frame: [460, 300, 260, 30], focused: state.focus === 'phone' }));
      const note = layout === 'trap' ? !state.phoneTyped : ['insert', 'frame'].includes(layout) && state.phoneTyped;
      if (note) out.push(n(next(), 'AXStaticText', { value: 'Check the phone number', frame: [460, 340, 200, 16] }));
      out.push(n(next(), 'AXStaticText', { value: '验证码已发送至186****0000', frame: [460, 410, 260, 18] }));
      const code = { ...(options.noIds ? {} : { domId: 'sms-code' }), frame: [460, 440, 1, 1], focused: state.focus === 'code', ...(layout === 'splitCode' ? { title: 'Code 2' } : {}) };
      if (state.rejected) out.push(n(next(), 'AXStaticText', { value: '验证码错误', frame: [460, options.errorAbove ? 425 : 470, 200, 12] }));
      const twins = ['twinFrames', 'twinDrop', 'twinSwap', 'twinDropOther', 'twinIds'].includes(layout);
      if (layout === 'frame' || layout === 'fragment' || twins) {
        const address = layout === 'fragment' && state.phoneTyped ? 'https://secure.example.test/sms#sent' : 'https://secure.example.test/sms';
        // Except with `twinFrames`, each frame names its own field, so both read alike.
        const named = twins && layout !== 'twinFrames';
        const frameA = () => {
          const frameRef = next();
          out.push(n(frameRef, 'AXWebArea', { url: address, frame: [440, 400, 320, 120] }));
          if (named) out.push(n(`${frameRef}.0`, 'AXStaticText', { value: '验证码', frame: [460, 420, 60, 16] }));
          out.push(n(`${frameRef}.1`, 'AXTextField', code));
        };
        const frameB = () => {
          if (!twins) return;
          const twin = next();
          out.push(n(twin, 'AXWebArea', { url: options.noIds && layout === 'twinDrop' ? 'https://secure.example.test/sms-b' : address, frame: [440, 600, 320, 120] }));
          if (named) out.push(n(`${twin}.0`, 'AXStaticText', { value: '验证码', frame: [460, 620, 60, 16] }));
          out.push(n(`${twin}.1`, 'AXTextField', { ...(options.noIds ? {} : { domId: layout === 'twinIds' ? 'sms-code-b' : 'sms-code' }), frame: [460, 640, 1, 1] }));
        };
        if (layout === 'twinSwap' && state.phoneTyped) {
          frameB();
          frameA();
        } else {
          if (!(layout === 'twinDrop' && state.phoneTyped)) frameA();
          if (!(layout === 'twinDropOther' && state.focus !== 'code') && !(layout === 'twinIds' && state.rejected)) frameB();
        }
      } else if (state.paid) {
        out.push(n(next(), 'AXStaticText', { value: 'Payment complete', frame: [460, 440, 200, 16] }));
        out.push(n(next(), 'AXTextField', { domId: 'bot-trap', frame: [460, 460, 1, 1] }));
      } else if (!(['dupIdDrop', 'dupIdLate'].includes(layout) && state.phoneTyped)) out.push(n(next(), 'AXTextField', code));
      if (layout === 'trap') out.push(n(next(), 'AXTextField', { domId: 'bot-trap', frame: [460, 460, 1, 1] }));
      if (layout === 'dupId' || layout === 'dupIdDrop' || (layout === 'dupIdLate' && state.lateTwin)) {
        out.push(n(next(), 'AXTextField', { domId: 'sms-code', frame: [460, 460, 1, 1] }));
      }
      out.push(n(next(), 'AXButton', { title: '确定', frame: [460, 500, 290, 36] }));
      return out;
    };
    const driver: HandoffDriver = {
      permission: async () => 'granted',
      requestPermission: async () => undefined,
      windows: async () => ({ frontmost: 20, apps: [{ ...chrome, windows: [{ index: 0, title: 'Pay', frame: [0, 0, 1200, 900], focused: true, minimized: false }] }] }),
      snapshot: async () => ({ ...chrome, frontmost: true, window: { index: 0, title: 'Pay', frame: [0, 0, 1200, 900] }, nodes: nodes() }),
      commandLine: async () => '',
      act: async (request) => {
        const ref = (request as { ref?: string }).ref;
        acts.push({ kind: request.kind, ref });
        if (request.kind === 'text') {
          if (state.secondStep) state.focus = 'password';
          else if (ref === '0.1' && state.stalePhone) { state.stalePhone = false; state.lateTwin = true; return { error: 'stale' }; }
          else if (ref === '0.1') { state.focus = 'phone'; state.phoneTyped = true; } else if (state.stale) { state.stale = false; return { error: 'stale' }; } else state.focus = 'code';
        } else if (layout === 'twoSteps' && !state.secondStep) {
          state.secondStep = true;
          state.focus = 'none';
        } else if (options.rejects) {
          state.rejected = true;
          state.focus = 'none';
        }
        return { ok: true };
      },
    };
    return { driver, state, acts };
  }

  // PR #12780 reviews (greptile r4691885603; codex r4691958410 / r4692228763 / r4692664851 / r4692664827 /
  // r4692664842): typing the phone moves the focus off the shrunken code field, and the page may shift tree positions,
  // let another hidden field take the old place, hold the code in a frame that moves, or re-render under the fill.
  // Each dropped or mixed up the code field, so only the phone was typed and nothing was submitted.
  // Entry: session.submit. Unit tier.
  it.each([
    { name: 'focus moves', layout: 'focus' as const, typed: ['0.1', '0.3'] },
    { name: 'the page inserts a line and tree positions shift', layout: 'insert' as const, typed: ['0.1', '0.4'] },
    { name: 'another hidden field takes its old place', layout: 'trap' as const, typed: ['0.1', '0.3'] },
    { name: 'its frame moves down the tree', layout: 'frame' as const, typed: ['0.1', '0.4.1'] },
    { name: 'the fill finds it stale once', layout: 'focus' as const, staleOnce: true, typed: ['0.1', '0.3', '0.3'] },
    { name: 'its frame rewrites the address fragment', layout: 'fragment' as const, typed: ['0.1', '0.3.1'] },
    { name: 'the phone shares its fingerprint', layout: 'sameFp' as const, typed: ['0.2', '0.4'] },
  ])('types a hidden code field found focused after an earlier field ($name)', async ({ layout, staleOnce, typed }) => {
    const page = payPage({ layout, staleOnce });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(2);
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.acts.filter((act) => act.kind === 'text').map((act) => act.ref)).toEqual(typed);
    // Then the step is confirmed (the page's button or Return), as after any complete form.
    expect(['press', 'key']).toContain(page.acts.at(-1)?.kind);
    session.cancel();
  });

  // PR #12780 review (codex r4692932785): the keys were kept for the whole address, so the next form on the same
  // address inherited them: a never-focused 1x1 field it remounted with the code's id joined the password step.
  // Entry: session.submit of the first step, then the next card. Unit tier.
  it('does not carry a hidden code field over to the next form on the same address', async () => {
    const page = payPage({ layout: 'twoSteps' });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const first = latest();
    const texts = first.controls.filter((control) => control.kind === 'text');
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: first.revision, values, action: { kind: 'submit' } });
    expect(page.state.secondStep).toBe(true);
    const second = latest();
    expect(second.controls.filter((control) => control.kind === 'text').map((control) => control.kind === 'text' && control.contentType)).toEqual(['password']);
    session.cancel();
  });

  // PR #12780 reviews (codex r4692228746, r4693191354): the owner clicks the phone field on the window while the card
  // waits; the window watch re-read dropped the unfocused code field and handed back as done outside (steps=0). With
  // `sameFp`, dropping it made the phone's fingerprint unique, so its identity no longer matched the card's.
  // PR #12780 review (codex r4693957106, `twinDropOther`): the other frame at the code's address went, so the code's
  // key no longer held; a read that cannot tell whose the code is is no evidence the owner finished.
  it.each(['focus', 'sameFp', 'twinDropOther'] as const)('keeps waiting when the owner moves the focus off a hidden code field on the window (%s)', async (layout) => {
    const page = payPage({ layout });
    const { session, latest, finished } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' }, windowWatchMs: 2 });
    await session.start();
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    page.state.focus = 'phone';
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(finished).toEqual([]);
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    session.cancel();
  });

  // PR #12780 review (codex r4693191346): the inserted line rebinds the code field to a new tree place; once the page
  // rejects the code and takes the focus off it, the re-read lost the code and handed back as succeeded.
  // Entry: session.submit. Unit tier.
  // PR #12780 review (codex r4693448408): typing the phone removed the code's frame; a second frame at the same address
  // then took its order and inherited the code's key, so the code went into that frame's never-focused field.
  // Entry: session.submit. Unit tier.
  // PR #12780 review (codex r4693715714): without page ids, the second frame (another address) took the removed frame's
  // tree place, and a key of tree place alone, without its document, handed it the code.
  // PR #12780 review (codex r4693957096, `twinSwap`): swapping the frames swapped their order too, so the never-focused
  // field took the code's key. Two frames at one address with alike fields (`twinFrames`) cannot tell whose the code
  // is once the focus moves: the fill stops instead of guessing (codex r4693191365 had it take in both).
  it.each([
    { layout: 'twinFrames' as const, noIds: false },
    { layout: 'twinDrop' as const, noIds: false },
    { layout: 'twinDrop' as const, noIds: true },
    { layout: 'twinSwap' as const, noIds: false },
    // PR #12780 reviews (codex r4694200899, r4694200914): without ids the swapped frame's field took the code's tree
    // place; with ids read alike, removing the focused one left the other alone in the code's key.
    { layout: 'twinSwap' as const, noIds: true },
    { layout: 'dupIdDrop' as const, noIds: false },
  ])('does not hand a hidden code field over to another frame once its own moves or goes away (%o)', async ({ layout, noIds }) => {
    const page = payPage({ layout, noIds });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(2);
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.acts.map((act) => act.ref ?? act.kind)).toEqual(['0.1']);
    session.cancel();
  });

  // PR #12780 review (codex r4693957115): ids are read cut off at 64 characters, so another never-focused 1x1 field
  // read with the code's id and fingerprint; re-reading by key took it in too, and the fill failed before typing.
  // Entry: session.submit. Unit tier.
  it('types a hidden code field when another field reads with the same cut-off id', async () => {
    const page = payPage({ layout: 'dupId' });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(1);
    await session.submit({ expectedRevision: step.revision, values: { [texts[0].id]: '123456' }, action: { kind: 'submit' } });
    expect(page.acts.filter((act) => act.kind === 'text').map((act) => act.ref)).toEqual(['0.2']);
    expect(['press', 'key']).toContain(page.acts.at(-1)?.kind);
    session.cancel();
  });

  // PR #12780 review (codex r4693448414): a field plan joins a visible box and the shrunken code field into one; once
  // the page rejects the code and takes the focus off it, the joined field was compared with the page's two and lost.
  // Entry: session.submit with a field plan. Unit tier.
  it('keeps a hidden code field a field plan joined with another box when the page rejects the code', async () => {
    const page = payPage({ layout: 'splitCode', rejects: true });
    const { session, latest, finished } = harness(page.driver, {
      target: { app: 'Google Chrome', windowTitle: 'Pay' },
      fields: [{ label: 'Code', contentType: 'one-time-code', targets: [{ label: 'Code 1', length: 3 }, { label: 'Code 2', length: 3 }] }],
    });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(1);
    await session.submit({ expectedRevision: step.revision, values: { [texts[0].id]: '123456' }, action: { kind: 'submit' } });
    expect(page.acts.filter((act) => act.kind === 'text').map((act) => act.ref)).toEqual(['0.1', '0.3']);
    expect(page.state.rejected).toBe(true);
    expect(finished).toEqual([]);
    expect(latest().phase).toBe('ready');
    expect(latest().controls.filter((control) => control.kind === 'text').map((control) => control.label)).toEqual(['Code']);
    session.cancel();
  });

  // PR #12780 review (codex r4694414326, `dupIdLate`): the code's key was unique on the card, then a field read alike
  // appeared. The submit check saw both (the code still focused) but kept the old key, so once typing the phone removed
  // the code, the other field passed with it and got the code. Entry: session.submit. Unit tier.
  it('drops a hidden code key that turned ambiguous before the fill', async () => {
    const page = payPage({ layout: 'dupIdLate' });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(2);
    page.state.lateTwin = true;
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.acts.map((act) => act.ref ?? act.kind)).toEqual(['0.1']);
    session.cancel();
  });

  // PR #12780 review (codex r4694619550): the same, with the field read alike first seen by the stale retry's re-read;
  // it dropped the key there but left it on the step. Entry: session.submit. Unit tier.
  it('drops a hidden code key that the stale retry found ambiguous', async () => {
    const page = payPage({ layout: 'dupIdLate', stalePhone: true });
    const { session, latest } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(2);
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.acts.map((act) => act.ref ?? act.kind)).toEqual(['0.1', '0.1']);
    session.cancel();
  });

  // PR #12780 review (codex r4694619559): the page turned the phone into plain text while the code stayed focused; one
  // field gone, as many as the hidden ones, read as the code lost, so the card froze on the old step.
  // Entry: window watch. Unit tier.
  it('shows the code alone once the page turns the field before it into text', async () => {
    const page = payPage();
    const { session, latest, finished } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' }, windowWatchMs: 2 });
    await session.start();
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    page.state.phoneStatic = true;
    await vi.waitFor(() => expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(1));
    expect(finished).toEqual([]);
    session.cancel();
  });

  // PR #12780 review (codex r4694414343): with the agent's success text on the page, a read that only lost the code
  // (a never-focused hidden field remaining) froze the card instead of handing back. Entry: window watch. Unit tier.
  it('hands back on the agent\'s completion text even while a hidden field remains', async () => {
    const page = payPage();
    const { session, finished } = harness(page.driver, {
      target: { app: 'Google Chrome', windowTitle: 'Pay' }, windowWatchMs: 2, completeWhen: { textAppears: 'Payment complete' },
    });
    await session.start();
    page.state.focus = 'phone';
    page.state.paid = true;
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: 'succeeded' });
  });

  // PR #12780 review (codex r4694200929, `twinIds`): the rejected code removed the other frame at the code's address;
  // the settled read after the submit lost the code and handed back as succeeded. Entry: session.submit. Unit tier.
  it('stays on the card when a rejected code also removes another frame at its address', async () => {
    const page = payPage({ layout: 'twinIds', rejects: true });
    const { session, latest, finished } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    expect(texts).toHaveLength(2);
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.acts.filter((act) => act.kind === 'text').map((act) => act.ref)).toEqual(['0.1', '0.3.1']);
    expect(page.state.rejected).toBe(true);
    expect(finished).toEqual([]);
    expect(latest().phase).toBe('ready');
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    session.cancel();
  });

  // PR #12780 review (codex r4694200936): the owner moved on to the next form on the window, which keeps a hidden
  // field of its own; the window watch kept the old card instead of showing the password step.
  it('shows the next form the owner reached on the window even when it lays out a hidden field', async () => {
    const page = payPage({ layout: 'twoSteps' });
    const { session, latest, finished } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' }, windowWatchMs: 2 });
    await session.start();
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    page.state.secondStep = true;
    page.state.focus = 'password';
    await vi.waitFor(() => expect(latest().controls.filter((control) => control.kind === 'text')
      .map((control) => control.kind === 'text' && control.contentType)).toEqual(['password']));
    expect(finished).toEqual([]);
    session.cancel();
  });

  // PR #12780 review (codex r4693715737, `errorAbove`): the error shown right above the code renamed it, and the
  // renamed field no longer matched the card's, so the code was lost and the card handed back as succeeded.
  it.each([{ errorAbove: false }, { errorAbove: true }])('stays on the card when the page rejects a hidden code field whose tree place moved (%o)', async ({ errorAbove }) => {
    const page = payPage({ layout: 'insert', rejects: true, errorAbove });
    const { session, latest, finished } = harness(page.driver, { target: { app: 'Google Chrome', windowTitle: 'Pay' } });
    await session.start();
    const step = latest();
    const texts = step.controls.filter((control) => control.kind === 'text');
    const values = Object.fromEntries(texts.map((control, i) => [control.id, i === 0 ? '18600000000' : '123456']));
    await session.submit({ expectedRevision: step.revision, values, action: { kind: 'submit' } });
    expect(page.state.rejected).toBe(true);
    expect(finished).toEqual([]);
    expect(latest().phase).toBe('ready');
    expect(latest().controls.filter((control) => control.kind === 'text')).toHaveLength(2);
    session.cancel();
  });

  it('asks only for the fields to type, confirms with the page button and follows the flow across apps', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    let step = latest();
    expect(step.phase).toBe('ready');
    // Only the field: the page's Next button is Cindy's to press.
    expect(step.controls).toEqual([{ id: expect.any(String), kind: 'text', label: 'Email', contentType: 'email' }]);
    expect(await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } })).toBe(true);
    expect(desktop.acts.map((act) => act.kind)).toEqual(['text', 'press']);

    step = latest();
    expect(step.stepNumber).toBe(2);
    expect(step.source).toMatchObject({ app: 'Google Chrome', origin: 'https://auth.example.com' });
    expect(step.controls.map((control) => control.kind)).toEqual(['text']);
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'synthetic-secret' }, action: { kind: 'submit' } });

    // The consent page has only buttons: nothing left for the owner, so it is handed back.
    expect(latest().phase).toBe('finishing');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'detected', steps: 2, finalApp: 'Google Chrome' });
    expect(desktop.stage()).toBe('consent');
    expect(latest()).toMatchObject({ phase: 'succeeded', terminal: true });
    expect(JSON.stringify([finished, latest()])).not.toMatch(/owner@example|synthetic-secret/);
  });

  it('stays on a form that still asks when the owner switches to an app they already had open', async () => {
    const desktop = fakeDesktop({ rejects: true });
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    const step = latest();
    const press = desktop.driver.act;
    desktop.driver.act = async (request) => {
      const result = await press(request);
      if (request.kind === 'press') desktop.switchToBrowser();
      return result;
    };
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(finished).toHaveLength(0);
    expect(latest()).toMatchObject({ phase: 'ready', source: { app: 'Example' } });
    expect(latest().controls.map((control) => control.kind)).toEqual(['text']);
  });

  it('never types for a request that ended while it waited for the desktop', async () => {
    // The first handoff holds the desktop; the second queues behind it and is cancelled meanwhile.
    const first = fakeDesktop();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const act = first.driver.act;
    first.driver.act = async (request) => {
      await held;
      return act(request);
    };
    const a = harness(first.driver);
    const second = fakeDesktop();
    const b = harness(second.driver, { requestId: 'req2' });
    await a.session.start();
    await b.session.start();
    const stepA = a.latest();
    const stepB = b.latest();
    const runningA = a.session.submit({ expectedRevision: stepA.revision, values: { [field(stepA).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    const values = { [field(stepB).id]: 'other@example.test' };
    const queuedB = b.session.submit({ expectedRevision: stepB.revision, values, action: { kind: 'submit' } });
    await vi.waitFor(() => expect(b.latest().phase).toBe('working'));
    b.session.cancel();
    release();
    await Promise.all([runningA, queuedB]);
    expect(second.acts).toEqual([]);
    expect(b.finished[0]).toMatchObject({ status: 'cancelled' });
    // The values of the ended request are dropped, not kept for later.
    expect(values).toEqual({});
  });

  it('ends as screen_locked when the screen locks after the card opened', async () => {
    const desktop = fakeDesktop();
    const { session, finished, latest } = harness(desktop.driver);
    await session.start();
    const step = latest();
    const act = desktop.driver.act;
    let locked = false;
    desktop.driver.act = async (request) => {
      const result = await act(request);
      if (request.kind === 'press') locked = true;
      return result;
    };
    const windows = desktop.driver.windows;
    desktop.driver.windows = async () => {
      if (locked) throw new Error('locked');
      return windows();
    };
    const snapshot = desktop.driver.snapshot;
    desktop.driver.snapshot = async (pid, window) => (locked ? { error: 'locked' } : snapshot(pid, window));
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'failed', failure: 'screen_locked' });
    expect(latest()).toMatchObject({ terminal: true });
  });

  it('ends at once when the screen has nothing to type', async () => {
    const desktop = fakeDesktop({ start: 'choose' });
    const { session, finished, published } = harness(desktop.driver);
    await session.start();
    expect(finished[0]).toMatchObject({ status: 'cancelled', reason: 'detected', failure: 'nothing_to_fill', steps: 0 });
    // The radio buttons and Continue never reached the owner.
    expect(published.every((snapshot) => snapshot.controls.length === 0)).toBe(true);
    expect(desktop.acts).toEqual([]);
  });

  it('presses Return in the last field when the page has no main button', async () => {
    const desktop = fakeDesktop();
    const driver: HandoffDriver = {
      ...desktop.driver,
      snapshot: async (pid, window) => {
        const raw = await desktop.driver.snapshot(pid, window);
        return 'nodes' in raw ? { ...raw, nodes: raw.nodes.filter((n) => n.role !== 'AXButton') } : raw;
      },
    };
    const { session, latest } = harness(driver);
    await session.start();
    const step = latest();
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'owner@example.test' }, action: { kind: 'submit' } });
    expect(desktop.acts.map((act) => [act.kind, act.value === 'return' ? 'return' : undefined])).toEqual([['text', undefined], ['key', 'return']]);
  });

  it('rejects stale or foreign submissions', async () => {
    const { session, latest } = harness(fakeDesktop().driver);
    await session.start();
    const step = latest();
    const submit = { kind: 'submit' } as const;
    expect(await session.submit({ expectedRevision: step.revision - 1, values: {}, action: submit })).toBe(false);
    expect(await session.submit({ expectedRevision: step.revision, values: { nope: 'x' }, action: submit })).toBe(false);
    // Typing without confirming belongs to screenshot steps only.
    expect(await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'x' }, action: { kind: 'fill' } })).toBe(false);
  });

  it('lets the owner stay, hand back or cancel', async () => {
    const desktop = fakeDesktop({ start: 'password' });
    const { session, finished, latest } = harness(desktop.driver, { finishingDelayMs: 60_000, target: { app: 'Google Chrome' } });
    await session.start();
    const step = latest();
    await session.submit({ expectedRevision: step.revision, values: { [field(step).id]: 'synthetic-secret' }, action: { kind: 'submit' } });
    expect(latest().phase).toBe('finishing');
    expect(await session.decide({ kind: 'input_handoff', action: 'stay', expectedRevision: latest().revision })).toBe(true);
    expect(latest()).toMatchObject({ phase: 'ready', controls: [] });
    expect(await session.decide({ kind: 'input_handoff', action: 'done', expectedRevision: latest().revision })).toBe(true);
    expect(finished[0]).toMatchObject({ status: 'succeeded', reason: 'owner' });
    expect(await session.decide({ kind: 'input_handoff', action: 'cancel', expectedRevision: latest().revision })).toBe(false);
  });

  // 2026-11-14: once a key was accepted, a settings form whose fields all had content must not become the next step;
  // the field the agent pointed at keeps its card even with content in it, so the owner can replace it or leave it.
  it('asks for a field with content on the page it was asked about, and hands back on a filled form after it', async () => {
    let saved = false;
    const field = (ref: string, title: string) => ({ ref, role: 'AXTextField', depth: 1, fp: `f|${title}`, title, hasValue: true, frame: [10, 10, 200, 30] });
    const button = { ref: '9', role: 'AXButton', depth: 1, fp: 'b|Save', title: 'Save', frame: [10, 60, 80, 30] };
    const app = { pid: 42, app: 'Example', bundleId: 'com.example.app' };
    const driver: HandoffDriver = {
      permission: async () => 'granted',
      requestPermission: async () => undefined,
      windows: async () => ({ frontmost: 42, apps: [{ ...app, windows: [{ index: 0, title: 'Settings', frame: [0, 0, 800, 600], focused: true, minimized: false }] }] }),
      snapshot: async () => ({
        ...app,
        frontmost: true,
        window: { index: 0, title: 'Settings', frame: [0, 0, 800, 600] },
        nodes: saved ? [field('0', 'Name'), field('1', 'Homepage URL'), button] : [field('0', 'API key'), button],
      }),
      commandLine: async () => '',
      act: async (request) => {
        if (request.kind !== 'text') saved = true;
        return { ok: true };
      },
      capture: async () => ({ error: 'unavailable' }),
    };
    const { session, finished, latest } = harness(driver, { finishingDelayMs: 60_000 });
    await session.start();
    const step = latest();
    expect(step.controls).toEqual([expect.objectContaining({ kind: 'text', label: 'API key', filled: true })]);
    await session.submit({ expectedRevision: step.revision, values: { [step.controls[0].id]: 'synthetic-key' }, action: { kind: 'submit' } });
    expect(latest()).toMatchObject({ phase: 'finishing', controls: [] });
    expect(finished).toHaveLength(0);
  });

  // PR #10497 P1: controls inserted before an existing filled key change its generated id.
  // The old tests only replaced the entire form. Exercise both submit and window-watch through
  // the public session API; a filled key must remain available for replacement (unit, fake time).
  it.each(['submit', 'watch'] as const)('keeps the same filled key when navigation loads during %s', async (route) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let navigation = false;
    const app = { pid: 42, app: 'Example', bundleId: 'com.example.app' };
    const driver: HandoffDriver = {
      permission: async () => 'granted',
      requestPermission: async () => undefined,
      windows: async () => ({ frontmost: 42, apps: [{ ...app, windows: [{ index: 0, title: 'Settings', frame: [0, 0, 800, 600], focused: true, minimized: false }] }] }),
      snapshot: async () => ({
        ...app, frontmost: true,
        window: { index: 0, title: 'Settings', frame: [0, 0, 800, 600] },
        nodes: [
          ...(navigation ? [{ ref: '0', role: 'AXButton', depth: 1, fp: 'b|Help', title: 'Help', frame: [10, 100, 80, 30] }] : []),
          { ref: '1', role: 'AXTextField', depth: 1, fp: 'f|API key', title: 'API key', hasValue: true, frame: [10, 10, 200, 30] },
          { ref: '2', role: 'AXButton', depth: 1, fp: 'b|Save', title: 'Save', frame: [10, 60, 80, 30] },
        ],
      }),
      commandLine: async () => '',
      act: async () => { navigation = true; return { ok: true }; },
      capture: async () => ({ error: 'unavailable' }),
    };
    const { session, finished, latest } = harness(driver);
    try {
      await session.start();
      const step = latest();
      if (route === 'submit') {
        await session.submit({ expectedRevision: step.revision, values: {}, action: { kind: 'submit' } });
      } else {
        await vi.advanceTimersByTimeAsync(2000);
        navigation = true;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(latest()).toMatchObject({ phase: 'ready', controls: [expect.objectContaining({ kind: 'text', label: 'API key', filled: true })] });
      expect(finished).toHaveLength(0);
    } finally {
      session.cancel();
      vi.useRealTimers();
    }
  });

  it('hands back once only a search box is left', async () => {
    const desktop = fakeDesktop({ start: 'done' });
    const { session, finished } = harness(desktop.driver);
    await session.start();
    expect(finished[0]).toMatchObject({ failure: 'nothing_to_fill' });
  });

  it('fails clearly without accessibility permission or target', async () => {
    const desktop = fakeDesktop();
    const noPermission = harness({ ...desktop.driver, permission: async () => 'missing' });
    await noPermission.session.start();
    expect(noPermission.finished[0]).toMatchObject({ status: 'failed', failure: 'permission' });
    const noTarget = harness(desktop.driver, { target: { app: 'Missing App' } });
    await noTarget.session.start();
    expect(noTarget.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
    const host = harness(desktop.driver, { target: { pid: 1 } });
    await host.session.start();
    expect(host.finished[0]).toMatchObject({ status: 'failed', failure: 'target_gone' });
  });

  it('flags agent-controlled browsers', async () => {
    const desktop = fakeDesktop();
    const { session, latest } = harness({ ...desktop.driver, commandLine: async () => 'Chromium --remote-debugging-port=9222' });
    await session.start();
    expect(latest().agentControlled).toBe(true);
  });
});
