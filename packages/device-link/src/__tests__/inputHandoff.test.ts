import { describe, expect, it } from 'vitest';
import type { InputHandoffSnapshot } from '../inputHandoff.js';
import {
  INPUT_HANDOFF_PICTURE_MAX_BYTES,
  INPUT_HANDOFF_PICTURE_MAX_SIDE,
  inputHandoffHeldElsewhere,
  inputHandoffPresentation,
  inputHandoffStepKey,
  parseInputHandoffDecision,
  parseInputHandoffOffer,
  parseInputHandoffPicture,
  parseInputHandoffPresentation,
  parseInputHandoffQr,
  parseInputHandoffSubmission,
  inputHandoffQrContent,
  inputHandoffQrLink,
  validateInputHandoffSubmissionForStep,
} from '../inputHandoff.js';

const controls: InputHandoffSnapshot['controls'] = [
  { id: 'c0', kind: 'text', label: 'Email', contentType: 'email' },
  { id: 'c1', kind: 'note', tone: 'error', text: 'Enter a valid email' },
];

describe('代输入 holder', () => {
  it('is free for everyone until a device starts handling it', () => {
    expect(inputHandoffHeldElsewhere({}, { local: true })).toBe(false);
    expect(inputHandoffHeldElsewhere({}, { deviceId: 'phone-1' })).toBe(false);
  });

  it('tells each device whether someone else is handling it', () => {
    const onPhone = { holder: { deviceId: 'phone-1' } };
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: 'phone-1' })).toBe(false);
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: 'desk-2' })).toBe(true);
    expect(inputHandoffHeldElsewhere(onPhone, { local: true })).toBe(true);
    // A device without a known id can never be mistaken for the holder.
    expect(inputHandoffHeldElsewhere(onPhone, { deviceId: null })).toBe(true);

    const onHost = { holder: { local: true as const } };
    expect(inputHandoffHeldElsewhere(onHost, { local: true })).toBe(false);
    expect(inputHandoffHeldElsewhere(onHost, { deviceId: 'phone-1' })).toBe(true);
  });

  it('accepts take-over as a value-less decision', () => {
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'claim', expectedRevision: 3 })).toEqual({
      kind: 'input_handoff',
      action: 'claim',
      expectedRevision: 3,
    });
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'steal', expectedRevision: 3 })).toBeNull();
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'decline', expectedRevision: 3 })).toBeNull();
  });
});

describe('代输入 step key', () => {
  const base = { requestId: 'req1', stepNumber: 1, controls };

  it('stays the same when only the revision moves, so a take-over keeps the draft', () => {
    expect(inputHandoffStepKey(base)).toBe(inputHandoffStepKey({ ...base, controls: controls.map((c) => ({ ...c })) }));
  });

  it('changes for a new step or a different screen', () => {
    expect(inputHandoffStepKey({ ...base, stepNumber: 2 })).not.toBe(inputHandoffStepKey(base));
    const password: InputHandoffSnapshot['controls'] = [
      { id: 'c0', kind: 'text', label: 'Password', contentType: 'password' },
      controls[1]!,
    ];
    expect(inputHandoffStepKey({ ...base, controls: password })).not.toBe(inputHandoffStepKey(base));
  });

  it('gives a screenshot step its own key, so a form draft never carries over', () => {
    expect(inputHandoffStepKey({ ...base, picture: true })).not.toBe(inputHandoffStepKey(base));
  });
});

describe('代输入 screenshot step', () => {
  const picture = { mime: 'image/jpeg', width: 640, height: 400, data: 'AAAA' };
  const presentation = {
    requestId: 'req1',
    revision: 4,
    purpose: 'Sign in',
    source: { app: 'Chrome' },
    command: null,
    controls: [{ id: 'typed', kind: 'text', label: '' }],
    picture: true,
    qr: false,
  };
  const state = 'a'.repeat(43);

  it('accepts a bounded JPEG and nothing else', () => {
    expect(parseInputHandoffPicture(picture)).toEqual(picture);
    for (const bad of [
      { ...picture, mime: 'image/png' },
      { ...picture, width: 0 },
      { ...picture, height: INPUT_HANDOFF_PICTURE_MAX_SIDE + 1 },
      { ...picture, data: '' },
      { ...picture, data: 'not base64!' },
      { ...picture, data: 'A'.repeat(Math.ceil(INPUT_HANDOFF_PICTURE_MAX_BYTES / 3) * 4 + 4) },
      { ...picture, extra: 1 },
    ])
      expect(() => parseInputHandoffPicture(bad)).toThrow();
  });

  it('carries the picture exactly when the presentation says it is a screenshot step', () => {
    expect(parseInputHandoffOffer({ kind: 'input-entry', state, presentation, picture }).picture).toEqual(picture);
    expect(() => parseInputHandoffOffer({ kind: 'input-entry', state, presentation })).toThrow();
    const form = { ...presentation, picture: false };
    expect(() => parseInputHandoffOffer({ kind: 'input-entry', state, presentation: form, picture })).toThrow();
    expect(parseInputHandoffOffer({ kind: 'input-entry', state, presentation: form }).picture).toBeUndefined();
  });

  it('requires the picture flag in every presentation', () => {
    const { picture: _flag, ...withoutFlag } = presentation;
    expect(() => parseInputHandoffPresentation(withoutFlag)).toThrow();
  });

  it('marks the presentation as a screenshot step without carrying pixels', () => {
    const snapshot = {
      requestId: 'req1',
      revision: 4,
      purpose: 'Sign in',
      source: { app: 'Chrome' },
      controls: [{ id: 'typed', kind: 'text', label: '', contentType: 'password' }],
      picture: true,
    } as unknown as InputHandoffSnapshot;
    expect(inputHandoffPresentation(snapshot)).toEqual(presentation);
  });

  it('parses a tap as fractions of the picture', () => {
    const tap = (action: unknown) => parseInputHandoffSubmission({ expectedRevision: 4, values: {}, action });
    expect(tap({ kind: 'tap', x: 0.25, y: 1 }).action).toEqual({ kind: 'tap', x: 0.25, y: 1 });
    for (const action of [
      { kind: 'tap', x: -0.1, y: 0.5 },
      { kind: 'tap', x: 0.5, y: 1.2 },
      { kind: 'tap', x: '0.5', y: 0.5 },
      { kind: 'tap', x: 0.5 },
      { kind: 'tap', x: 0.5, y: 0.5, button: 'right' },
    ])
      expect(() => tap(action)).toThrow();
  });

  it('allows a tap only on a screenshot step, and only without values', () => {
    const form = { revision: 4, controls: [{ id: 'typed', kind: 'text' as const, label: '', contentType: 'text' as const }] };
    const shot = { ...form, picture: true as const };
    const tap = { kind: 'tap', x: 0.5, y: 0.5 } as const;
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: {}, action: tap })).toBe(true);
    expect(validateInputHandoffSubmissionForStep(form, { expectedRevision: 4, values: {}, action: tap })).toBe(false);
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: { typed: 'x' }, action: tap })).toBe(false);
    expect(validateInputHandoffSubmissionForStep(shot, { expectedRevision: 3, values: {}, action: tap })).toBe(false);
    expect(
      validateInputHandoffSubmissionForStep(shot, { expectedRevision: 4, values: { typed: 'hello' }, action: { kind: 'submit' } }),
    ).toBe(true);
  });

  it('carries only typed text, confirmed by the page itself', () => {
    const form = { revision: 4, controls };
    const submit = { kind: 'submit' } as const;
    expect(validateInputHandoffSubmissionForStep(form, { expectedRevision: 4, values: { c0: 'a@example.test' }, action: submit })).toBe(true);
    // The error note is not a field.
    expect(validateInputHandoffSubmissionForStep(form, { expectedRevision: 4, values: { c1: 'x' }, action: submit })).toBe(false);
    // Typing without confirming is for screenshot steps only.
    expect(validateInputHandoffSubmissionForStep(form, { expectedRevision: 4, values: { c0: 'x' }, action: { kind: 'fill' } })).toBe(false);
    for (const bad of [
      { expectedRevision: 4, values: { c0: true }, action: submit },
      { expectedRevision: 4, values: {}, action: { kind: 'press', controlId: 'c1' } },
    ])
      expect(() => parseInputHandoffSubmission(bad)).toThrow();
    // Page buttons and options never reach another device.
    expect(() => parseInputHandoffPresentation({
      requestId: 'req1', revision: 4, purpose: 'Sign in', source: { app: 'Chrome' }, command: null, picture: false, qr: false,
      controls: [{ id: 'b0', kind: 'button', label: 'Next' }],
    })).toThrow();
  });

  it('accepts asking for the picture as a value-less decision', () => {
    expect(parseInputHandoffDecision({ kind: 'input_handoff', action: 'picture', expectedRevision: 2 })?.action).toBe('picture');
  });
});

describe('代输入 QR step', () => {
  const state = 'a'.repeat(43);
  const snapshot = {
    kind: 'input_handoff',
    requestId: 'req1',
    revision: 5,
    phase: 'ready',
    purpose: 'Sign in',
    source: { app: 'WeChat' },
    stepNumber: 1,
    controls: [],
    picture: true,
    qr: 'scan',
  } as InputHandoffSnapshot;
  const link = 'https://login.example.com/qr?token=abc';
  const picture = {
    mime: 'image/jpeg', width: 400, height: 400, data: 'AAAA',
    qr: { text: link, url: link },
  };

  it('says in the presentation that the picture is a code, and only for a code on screen', () => {
    expect(inputHandoffPresentation(snapshot).qr).toBe(true);
    expect(inputHandoffPresentation({ ...snapshot, qr: 'scanned', picture: undefined }).qr).toBe(false);
    expect(() => parseInputHandoffPresentation({ ...inputHandoffPresentation(snapshot), picture: false })).toThrow();
  });

  it('carries what the code says inside the sealed picture, and nowhere else', () => {
    const presentation = inputHandoffPresentation(snapshot);
    expect(parseInputHandoffOffer({ kind: 'input-entry', state, presentation, picture }).picture?.qr).toEqual(picture.qr);
    // A code step without its content, or a plain screenshot that claims one, is refused.
    const { qr: _qr, ...plain } = picture;
    expect(() => parseInputHandoffOffer({ kind: 'input-entry', state, presentation, picture: plain })).toThrow();
    expect(() => parseInputHandoffOffer({
      kind: 'input-entry', state, presentation: { ...presentation, qr: false }, picture,
    })).toThrow();
  });

  it('opens what a phone camera would open: web links and app links, nothing that runs or reads locally', () => {
    expect(inputHandoffQrLink(picture.qr)).toEqual({ url: link, site: 'login.example.com', web: true });
    // Some codes are a plain http page that hands over to an app; app links open the app directly.
    expect(inputHandoffQrContent(' http://192.168.1.2:8080/pair?t=1 ')).toEqual({ text: 'http://192.168.1.2:8080/pair?t=1', url: 'http://192.168.1.2:8080/pair?t=1' });
    expect(inputHandoffQrLink({ text: 'weixin://dl/login?t=1', url: 'weixin://dl/login?t=1' })).toEqual({ url: 'weixin://dl/login?t=1', site: 'weixin', web: false });
    expect(inputHandoffQrContent('alipays://platformapi/startapp?appId=1')?.url).toBe('alipays://platformapi/startapp?appId=1');
    for (const text of ['WIFI:S:home;T:WPA;P:secret;;', 'tel:10086', 'javascript://x%0Aalert(1)', 'data://text/html,x', 'file:///etc/hosts', 'https://u:p@login.example.com/', 'just words'])
      expect(inputHandoffQrContent(text)).toEqual({ text });
    expect(inputHandoffQrContent('')).toBeNull();
    expect(inputHandoffQrContent('a\u0007b')).toBeNull();
    expect(inputHandoffQrContent('x'.repeat(2049))).toBeNull();
    expect(parseInputHandoffQr({ text: 'WIFI:S:home;T:WPA;P:secret;;' })).toEqual({ text: 'WIFI:S:home;T:WPA;P:secret;;' });
    for (const bad of [
      { text: 'shown text', url: link },
      { text: 'javascript://x%0Aalert(1)', url: 'javascript://x%0Aalert(1)' },
      { text: 'https://u:p@login.example.com/', url: 'https://u:p@login.example.com/' },
      { text: link, url: link, origin: 'https://login.example.com' },
      { text: '' },
      { text: 'a\u0000b' },
      { text: 'x'.repeat(2049) },
      { text: link, extra: 1 },
    ])
      expect(() => parseInputHandoffQr(bad)).toThrow();
  });

  it('gives a new key when the code was scanned, so the scanned state is a new screen', () => {
    expect(inputHandoffStepKey(snapshot)).not.toBe(inputHandoffStepKey({ ...snapshot, qr: 'scanned', picture: undefined }));
  });
});
