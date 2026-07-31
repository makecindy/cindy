import type { ImUiTextPack } from '../shared/types';
import { ui as telegramUi } from '../telegram/uiText';

/**
 * Shared IM control copy is channel-neutral apart from a small number of
 * route labels. Keep the DingTalk pack derived at the composition boundary so
 * fixes to permissions, model selection, and takeover guidance stay aligned.
 */
const sharedUi = replaceChannelLabel(telegramUi);

export const ui = {
  ...sharedUi,
  slash: {
    ...sharedUi.slash,
    help: `🤖 我能帮你做这些：

/new   开个新对话（清掉当前上下文）
/stop  中止当前执行，并撤掉排队消息
/help  查看可用命令

模型、权限和远程接管请在 Cindy 桌面端调整。`,
    unknownCommand: (cmd: string) =>
      `没认出 \`${cmd}\` 这个命令 🤔\n我能听懂的：/new、/stop、/help`,
    interactiveCommandUnsupported: (cmd: string) =>
      `钉钉暂不支持 ${cmd} 的交互选择，请在 Cindy 桌面端完成对应设置。`,
  },
} satisfies ImUiTextPack;

function replaceChannelLabel<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replaceAll('Telegram', '钉钉').replaceAll('TG', '钉钉') as T;
  }
  if (typeof value === 'function') {
    return ((...args: unknown[]) =>
      replaceChannelLabel((value as (...input: unknown[]) => unknown)(...args))) as T;
  }
  if (Array.isArray(value)) return value.map(replaceChannelLabel) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceChannelLabel(child)]),
  ) as T;
}
