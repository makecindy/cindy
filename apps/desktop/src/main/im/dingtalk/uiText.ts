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
  error: {
    ...sharedUi.error,
    // 钉钉没有 /permission 交互卡，改为指路桌面端。群任务处于「完全访问」时
    // 只放行主人的轮次，其他成员的请求会落到这里。
    permissionModeUnsupported:
      '🤔 这条群任务开着「完全访问」，只有主人能直接使用。' +
      '如需让群里其他人也能用，请主人在 Cindy 桌面端把这条任务的权限换成「自动审批」，' +
      '或在钉钉设置里打开「群成员也使用「完全访问」」。',
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
