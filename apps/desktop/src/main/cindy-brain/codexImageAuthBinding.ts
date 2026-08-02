/**
 * Static assembly seam for the ChatGPT subscription image channel.
 *
 * cindy-brain must not runtime-import the full maker-host auth graph: Rollup would
 * emit a lazy chunk that can re-enter the Desktop Main bundle. bootstrap-electron
 * wires these callbacks from its existing static maker-host imports before IPC
 * registration, while tests can exercise the image channel without that graph.
 */

export interface CodexImageAuthBinding {
  getAuth(): Promise<{ accessToken: string; accountId: string | null }>;
  onAuthFailure(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): unknown | Promise<unknown>;
}

let binding: CodexImageAuthBinding | null = null;

export function setCodexImageAuthBinding(next: CodexImageAuthBinding | null): void {
  binding = next;
}

export function getCodexImageAuthBinding(): CodexImageAuthBinding {
  if (!binding) {
    throw new Error('Codex image auth binding is not configured');
  }
  return binding;
}
