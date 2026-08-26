export type NativeVoiceActivationPhase = 'start' | 'tap' | 'end';
export type NativeVoiceActivationSource = 'shortcut' | 'hardware';

export interface NativeVoiceActivationDecision {
  owner: NativeVoiceActivationSource | null;
  deliver: boolean;
}

/**
 * One native dictation owner at a time.
 *
 * Hardware and the system shortcut share the same overlay. A second source
 * must not steal the held start or consume the owner's release.
 */
export function resolveNativeVoiceActivation(
  owner: NativeVoiceActivationSource | null,
  phase: NativeVoiceActivationPhase,
  source: NativeVoiceActivationSource,
  recording: boolean,
): NativeVoiceActivationDecision {
  if (phase !== 'end' && recording) {
    if (phase === 'start' && owner === source) {
      return { owner: null, deliver: false };
    }
    return { owner, deliver: false };
  }
  if (phase === 'end') {
    if (owner !== source) return { owner, deliver: false };
    return { owner: null, deliver: true };
  }
  if (owner && owner !== source) {
    return { owner, deliver: false };
  }
  return { owner: phase === 'start' ? source : null, deliver: true };
}
