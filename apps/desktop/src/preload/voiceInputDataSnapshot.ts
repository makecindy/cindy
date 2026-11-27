import { ipcRenderer } from 'electron';
import type { VoiceInputDataSnapshot } from '../shared/voiceInputData';

/** Keep hot settings reads in preload; the host remains the data owner. */
export function createVoiceInputDataSnapshot() {
  let current: VoiceInputDataSnapshot | undefined;
  let readError: unknown;
  const replace = (snapshot: VoiceInputDataSnapshot) => { current = snapshot; readError = undefined; };
  const refresh = () => {
    // A failed owner transition must never leave the previous owner's data readable.
    current = undefined;
    try {
      replace(ipcRenderer.sendSync('voice-input:data:get') as VoiceInputDataSnapshot);
    } catch (error) {
      readError = error;
    }
  };
  refresh();
  ipcRenderer.on('voice-input:data-changed', (_event, snapshot: VoiceInputDataSnapshot) => replace(snapshot));
  // Authentication can switch the owner without a settings write. Refresh at
  // that boundary, before renderer auth subscribers run, not on hover/render.
  ipcRenderer.on('auth:state-change', refresh);
  return { read: () => {
    if (!current) throw readError ?? new Error('Voice input data snapshot unavailable');
    return current;
  }, replace };
}
