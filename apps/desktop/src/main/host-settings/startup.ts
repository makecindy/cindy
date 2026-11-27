import type { CreateSessionOptions } from '@cindy/maker-core';
import { isManagedCloudInstance, windowUserPrompt } from './personalization.js';

/** 在生成项目上下文之前冻结启动偏好；后续拼接顺序和存活任务快照保持不变。
 * 托管云实例改用实例窗口里保存的正文，读不到时拒绝启动而不用控制端副本；普通桌面沿用 Renderer 随请求带来的正文。 */
export async function captureHostPersonalization(opts: Pick<CreateSessionOptions,
  'userPrompt' | 'hostStartupPreferences' | 'makerMemoryEnabled' | 'displayReasoning'>): Promise<void> {
  const userPrompt = isManagedCloudInstance() ? await windowUserPrompt() : opts.userPrompt;
  opts.userPrompt = userPrompt;
  opts.hostStartupPreferences = {
    userPrompt,
    makerMemoryEnabled: opts.makerMemoryEnabled,
    displayReasoning: opts.displayReasoning,
  };
}
