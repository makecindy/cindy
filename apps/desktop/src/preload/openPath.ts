import type { OpenPathResult } from '../shared/openPathResult';

/** Keep invoke transport failures inside the existing openPath result boundary. */
export async function invokeOpenPath(
  invoke: (channel: string, target: string) => Promise<OpenPathResult>,
  target: string,
): Promise<OpenPathResult> {
  try {
    return await invoke('shell:open-path', target);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const message = error.replace(
      /^Error invoking remote method ['"]shell:open-path['"]: (?:Error: )?/,
      '',
    );
    // Classify only rejected IPC calls; main's path/OS errors pass through unchanged.
    // No handler registered can mean version skew or broken initialization.
    const lifecycle =
      /^(?:reply was never sent[.!]?|Render frame was disposed(?: before WebFrameMain could be accessed)?[.!]?)$/.test(
        message,
      );
    return lifecycle
      ? { success: false, error, failureKind: 'ipc_lifecycle' }
      : { success: false, error };
  }
}
