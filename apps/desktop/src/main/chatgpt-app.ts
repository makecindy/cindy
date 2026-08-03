/** ChatGPT Desktop 注册的受限协议入口；不得由 renderer 传入自定义 deep link。 */
export const CHATGPT_APP_URL = 'codex://';

type OpenChatGPTAppDeps<TEvent> = {
  assertTrustedSender: (event: TEvent) => void;
  openExternal: (url: string) => Promise<void>;
};

export async function openChatGPTApp(
  openExternal: (url: string) => Promise<void>,
): Promise<{ success: boolean }> {
  try {
    await openExternal(CHATGPT_APP_URL);
    return { success: true };
  } catch {
    return { success: false };
  }
}

/** IPC 业务体：先验证 Cindy 顶层 Renderer，再执行固定协议副作用。 */
export async function handleOpenChatGPTApp<TEvent>(
  event: TEvent,
  deps: OpenChatGPTAppDeps<TEvent>,
): Promise<{ success: boolean }> {
  deps.assertTrustedSender(event);
  return openChatGPTApp(deps.openExternal);
}
