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
  /**
   * Best-effort 解析当前账号可用的 Codex Responses host 模型(按账号模型清单派生)。
   * 返回 null 或抛错都让通道侧退回静态兜底模型——解析失败绝不能挡住出图。
   */
  getHostModel?(): Promise<string | null>;
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
