import { ipcRenderer } from 'electron';

type Permission = { ok: true; status: string } | { ok: false; status: string; error: string };

/** Bootstrap once; pointer/hover handlers must never wait for the main thread. */
export function createMicrophonePermissionSnapshot(): () => Permission {
  let current = ipcRenderer.sendSync('voice-input:get-microphone-permission-cached') as Permission;
  ipcRenderer.on('voice-input:microphone-permission-changed', (_event, next: Permission) => {
    current = next;
  });
  return () => current;
}
