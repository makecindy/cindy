/**
 * Opt-in Android/iOS UI acceptance fixture. The screen still uses the real
 * microphone recorder. Only model availability, validation and storage are
 * replaced. No audio, voiceprint or preferences are persisted.
 * Enable with BOTH CINDY_MOBILE_VISUAL_MOCK and CINDY_SPEAKER_ENROLLMENT_SCENARIO
 * EXPO_PUBLIC flags in a development build. Submissions exercise each retry.
 */
import type { MobileSpeakerEnrollResult, MobileSpeakerFilterSnapshot } from '@/session/mobileSpeakerFilter';

let snapshot: MobileSpeakerFilterSnapshot = {
  supported: true, hydrated: true, enabled: true, enrolled: false,
  strictness: 'standard', strictnessCustomized: false,
  modelState: 'ready', downloadedBytes: 0, totalBytes: 0,
};
const listeners = new Set<() => void>();
let submission = 0;
const failures: MobileSpeakerEnrollResult[] = [
  { ok: false, reason: 'too_short', clipIndex: 0 },
  { ok: false, reason: 'no_embedding', clipIndex: 1 },
  { ok: false, reason: 'inconsistent', clipIndex: 2 },
  { ok: false, reason: 'too_short', clipIndex: 2 },
];
function update(patch: Partial<MobileSpeakerFilterSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export const speakerEnrollmentScenario = {
  getMobileSpeakerFilterSnapshot: () => snapshot,
  subscribeMobileSpeakerFilter(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  hydrateMobileSpeakerFilter: async () => {},
  setMobileSpeakerFilterEnabled: async (enabled: boolean) => { update({ enabled }); },
  setMobileSpeakerFilterStrictness: async (strictness: MobileSpeakerFilterSnapshot['strictness'] | null) => {
    update({ strictness: strictness ?? 'standard', strictnessCustomized: strictness !== null });
  },
  deleteMobileSpeakerProfile: async () => { submission = 0; update({ enrolled: false, enrolledAt: undefined }); },
  downloadMobileSpeakerModels: async () => {},
  cancelMobileSpeakerModelDownload: () => {},
  async enrollMobileSpeaker(_clips: ArrayBuffer[]): Promise<MobileSpeakerEnrollResult> {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const failure = failures[submission++];
    if (failure) return failure;
    update({ enrolled: true, enrolledAt: Date.now() });
    return { ok: true };
  },
};
