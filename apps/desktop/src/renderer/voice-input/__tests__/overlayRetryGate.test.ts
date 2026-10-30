import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const overlaySource = readFileSync(
  resolve(__dirname, '..', 'VoiceInputOverlay.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const bootstrapSource = readFileSync(
  resolve(__dirname, '../../../main/bootstrap-electron.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('voice input overlay retry gate', () => {
  it('keeps retry disabled until the stop IPC promise settles', () => {
    expect(overlaySource).toContain('const [stopInFlight, setStopInFlight] = useState(false);');
    expect(overlaySource).toContain('const stopInFlightRef = useRef(false);');
    expect(overlaySource).toContain('const errorCloseTimerRef = useRef<number | null>(null);');
    expect(overlaySource).toContain('clearErrorCloseTimer();');
    expect(overlaySource).toContain('scheduleErrorClose();');
    expect(overlaySource).toContain('setStopInFlight(true);');
    expect(overlaySource).toContain('setStopInFlight(false);');
    expect(overlaySource).toContain('if (stopInFlightRef.current) return;');
    expect(overlaySource).toContain('disabled={stopInFlight}');
    expect(overlaySource).toContain('if (!text) {\n      stateRef.current = \'done\';\n      commitUsageStats();');
  });

  it('uses the overlay-safe readiness IPC to build the recovery action', () => {
    expect(overlaySource).toContain('window.electronAPI.voiceInput.getReadiness()');
    expect(overlaySource).toContain('resolveVoiceInputReadinessRecovery(readiness, readiness.serviceMode)');
    expect(overlaySource).not.toContain('window.electronAPI.voiceInput.getModelSelection()');
  });

  it('keeps inline auth recovery visible and routes the global submit back through recovery', () => {
    expect(overlaySource).toContain("if (!opened.success) setError(t('chatgptAuthRecovery.openAppFailed'));");
    expect(overlaySource).toContain("if (codexRecovery) {\n            void handleCodexRecovery();");
    expect(overlaySource).toContain('codexSessionPromptActiveRef.current = false;\n          void startRecording();');
    expect(overlaySource).toContain('if (codexRecoveryPromptPending) return;');
    expect(overlaySource).toContain('disabled={stopInFlight || codexRecoveryBusy || codexRecoveryPromptPending}');
    expect(overlaySource).toContain('onPromptStarted: (reason) => {');
  });

  it('drops a delayed handoff after an immediate retry and leaves the paste gate open', async () => {
    Object.assign(globalThis, { window: { location: { href: 'http://localhost/' } } });
    const { isCurrentCodexRecoveryPromptAttempt } = await import('../VoiceInputOverlay');
    let currentAttemptId = 41;
    let pending: { attemptId: number; reason: string } | null = {
      attemptId: currentAttemptId,
      reason: 'token_revoked',
    };
    let gate = true;
    let recoveryEstablished = false;
    let resolveState!: (reason: string) => void;
    const delayedState = new Promise<string>((resolve) => {
      resolveState = resolve;
    });
    const delayedHandoff = delayedState.then((reason) => {
      if (!isCurrentCodexRecoveryPromptAttempt(pending, currentAttemptId, reason)) return;
      gate = true;
      recoveryEstablished = true;
    });

    pending = null;
    gate = false;
    currentAttemptId += 1;
    resolveState('token_revoked');
    await delayedHandoff;

    expect(recoveryEstablished).toBe(false);
    expect(gate).toBe(false);
    expect(!gate).toBe(true);
    expect(overlaySource).toContain('codexRecoveryPromptAttemptRef.current = null;');
    expect(overlaySource).toContain('invalidateCodexRecoveryPrompt();');
  });

  it('keeps the overlay ChatGPT App capability narrowly trusted', () => {
    expect(bootstrapSource).toContain('isGlobalVoiceInputOverlaySender(candidate.sender)');
    expect(bootstrapSource).toContain('candidate.senderFrame === candidate.sender.mainFrame');
    expect(bootstrapSource).toContain('isTrustedCindyRendererWindow(overlayWindow)');
    expect(bootstrapSource).toContain('assertTrustedAppRendererEvent(candidate);');
  });
});
