import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real page cleanup without mounting unrelated network/UI services.
// The audio session represents the already-playing remote desktop PiP.
function pageCleanup(page: string, recording: boolean, starting: boolean) {
  const source = ts.createSourceFile(
    page,
    readFileSync(resolve(process.cwd(), "app/sessions", page), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const cleanups: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect"
    ) {
      const effect = node.arguments[0];
      if (effect && ts.isArrowFunction(effect) && ts.isBlock(effect.body)) {
        for (const statement of effect.body.statements) {
          if (
            ts.isReturnStatement(statement) &&
            statement.expression &&
            ts.isArrowFunction(statement.expression) &&
            statement.expression
              .getText(source)
              .includes("voiceControllerSessionRef.current = null")
          ) {
            cleanups.push(statement.expression);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(cleanups).toHaveLength(1);
  const cancel = vi.fn(async () => undefined);
  const abort = vi.fn();
  const discardPendingPrewarm = vi.fn();
  const audio = { category: "playback", active: true };
  const setAudioModeAsync = vi.fn(async () => {
    audio.category = "ambient";
  });
  const bindings: Record<string, unknown> = {
    voiceControllerSessionRef: { current: recording ? { cancel } : null },
    voicePermissionRequestSeqRef: { current: 1 },
    voicePermissionRequestAbortRef: { current: { abort } },
    voicePermissionRequestInFlightRef: { current: starting },
    voiceStartupSeqRef: { current: 1 },
    voiceStartupInFlightRef: { current: starting },
    voiceStopInFlightRef: { current: false },
    voiceRecordingActiveRef: { current: recording },
    voiceLongPressActiveRef: { current: false },
    voiceSuppressNextPressRef: { current: false },
    voiceStopAfterStartRef: { current: false },
    voiceDictionaryLearningTrackerRef: { current: null },
    voiceStateTransitionRef: { current: "idle" },
    setVoiceState: vi.fn(),
    setComposerVoiceHoldArmed: vi.fn(),
    discardPendingPrewarm,
    setAudioModeAsync,
  };
  const compiled = ts.transpileModule(
    `const cleanup = ${cleanups[0].getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const cleanup = new Function(
    ...Object.keys(bindings),
    `${compiled}; return cleanup;`,
  )(...Object.values(bindings)) as () => void;
  return {
    cleanup,
    cancel,
    abort,
    discardPendingPrewarm,
    audio,
    setAudioModeAsync,
    bindings,
  };
}

describe.each(["new.tsx", "[sessionId].tsx"])("%s audio cleanup", (page) => {
  it.each([
    { recording: false, starting: false },
    { recording: false, starting: true },
    { recording: true, starting: false },
  ])(
    "preserves PiP and releases only voice resources: %j",
    ({ recording, starting }) => {
      const run = pageCleanup(page, recording, starting);
      run.cleanup();
      expect(run.audio).toEqual({ category: "playback", active: true });
      expect(run.setAudioModeAsync).not.toHaveBeenCalled();
      expect(run.cancel).toHaveBeenCalledTimes(recording ? 1 : 0);
      expect(run.abort).toHaveBeenCalledOnce();
      expect(run.discardPendingPrewarm).toHaveBeenCalledOnce();
      expect(run.bindings.voiceControllerSessionRef).toEqual({ current: null });
      expect(run.bindings.voiceStartupSeqRef).toEqual({ current: 2 });
      if (page === "[sessionId].tsx") {
        expect(run.bindings.setVoiceState).toHaveBeenCalledWith("idle");
      }
    },
  );
});
