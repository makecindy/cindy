import { describe, expect, it } from 'vitest';
import { MobileVoiceAudioLevels } from '@/session/mobileVoiceAudioLevels';

describe('recording level diagnostics', () => {
  it('distinguishes no samples from digital silence', () => {
    const levels = new MobileVoiceAudioLevels();
    expect(levels.summary()).toEqual({ capturedAudioMs: 0, rmsDbfs: undefined, peakDbfs: undefined });
    levels.append(new Int16Array(160).buffer, 16000);
    expect(levels.summary()).toEqual({ capturedAudioMs: 10, rmsDbfs: -90, peakDbfs: -90 });
  });

  it('weights RMS by samples rather than averaging packet levels', () => {
    const levels = new MobileVoiceAudioLevels();
    levels.append(new Int16Array(160).fill(-16384).buffer, 16000);
    levels.append(new Int16Array(480).buffer, 16000);
    expect(levels.summary()).toEqual({ capturedAudioMs: 40, rmsDbfs: -12, peakDbfs: -6 });
  });
});
