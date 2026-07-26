import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const overlaySource = readFileSync(
  resolve(__dirname, '..', 'VoiceInputOverlay.tsx'),
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
});
