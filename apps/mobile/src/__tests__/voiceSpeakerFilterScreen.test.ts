import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the real screen callbacks without mounting unrelated native settings UI.
const source = ts.createSourceFile('voice-speaker-filter.tsx',
  readFileSync(resolve(process.cwd(), 'app/settings/voice-speaker-filter.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(source) === 'useCallback') {
    callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source));
  }
  if (ts.isJsxAttribute(node) && node.name.getText(source) === 'onValueChange'
    && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    callbacks.set('toggle', node.initializer.expression.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
class Aborted extends Error {}
class NoAudio extends Error {}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function harness() {
  const bindings = {
    abortRef: { current: null as AbortController | null },
    stopRef: { current: null as AbortController | null },
    clipsRef: { current: [null, null, null] },
    recording: false, saving: false, current: 0,
    CLIP_INDEXES: [0, 1, 2], CLIP_SECONDS: 30,
    setClips: vi.fn(), setCurrent: vi.fn(), setRecording: vi.fn(),
    setProgress: vi.fn(), setSaving: vi.fn(), setEnrollError: vi.fn(), setEnrolling: vi.fn(), setRetryIndex: vi.fn(),
    setMobileSpeakerFilterEnabled: vi.fn(async () => {}),
    reportActionFailure: vi.fn(),
    recordMobileSpeakerClip: vi.fn(),
    MobileSpeakerEnrollmentAbortedError: Aborted,
    MobileSpeakerEnrollmentNoAudioError: NoAudio,
  };
  const js = ts.transpileModule(`
    const resetEnrollment = ${callbacks.get('resetEnrollment')};
    return { record: ${callbacks.get('record')}, reset: resetEnrollment, toggle: ${callbacks.get('toggle')} };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions = new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as {
    record(): Promise<void>; reset(): void; toggle(value: boolean): void;
  };
  return { ...bindings, ...actions };
}

describe('speaker enrollment screen cancellation', () => {
  it('reports a failed switch save instead of leaving an unhandled rejection', async () => {
    const h = harness();
    h.setMobileSpeakerFilterEnabled.mockRejectedValueOnce(new Error('disk full'));
    h.toggle(true);
    await Promise.resolve();
    expect(h.reportActionFailure).toHaveBeenCalledOnce();
  });

  it('does not start two recordings before React renders the busy state', async () => {
    const h = harness();
    const clip = deferred<ArrayBuffer>();
    h.recordMobileSpeakerClip.mockReturnValue(clip.promise);
    const first = h.record();
    await h.record();
    expect(h.recordMobileSpeakerClip).toHaveBeenCalledOnce();
    clip.resolve(new ArrayBuffer(4));
    await first;
    expect(h.abortRef.current).toBeNull();
  });

  it('ignores an old recording settling after cancel and restart', async () => {
    const h = harness();
    const oldClip = deferred<ArrayBuffer>();
    const newClip = deferred<ArrayBuffer>();
    h.recordMobileSpeakerClip.mockReturnValueOnce(oldClip.promise).mockReturnValueOnce(newClip.promise);
    const first = h.record();
    const oldOptions = h.recordMobileSpeakerClip.mock.calls[0][0];
    h.reset();
    const second = h.record();
    const newController = h.abortRef.current;
    h.setProgress.mockClear();
    h.setRecording.mockClear();
    oldOptions.onProgress(0.8);
    oldClip.reject(new Aborted());
    await first;
    expect(oldOptions.signal.aborted).toBe(true);
    expect(h.abortRef.current).toBe(newController);
    expect(h.setRecording).not.toHaveBeenCalled();
    expect(h.setProgress).not.toHaveBeenCalled();
    newClip.resolve(new ArrayBuffer(4));
    await second;
    expect(h.setRecording).toHaveBeenLastCalledWith(false);
  });

  it('turning the feature off cancels capture and closes enrollment', async () => {
    const h = harness();
    const clip = deferred<ArrayBuffer>();
    h.recordMobileSpeakerClip.mockReturnValue(clip.promise);
    const recording = h.record();
    const options = h.recordMobileSpeakerClip.mock.calls[0][0];
    h.toggle(false);
    expect(options.signal.aborted).toBe(true);
    expect(h.setEnrolling).toHaveBeenCalledWith(false);
    expect(h.setMobileSpeakerFilterEnabled).toHaveBeenCalledWith(false);
    clip.reject(new Aborted());
    await recording;
    expect(h.setClips).toHaveBeenCalledExactlyOnceWith([null, null, null]);
  });
});
