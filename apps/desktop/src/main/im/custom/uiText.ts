/**
 * 自定义渠道的文案包。
 *
 * 这个渠道只发文本、不渲染卡片。文案复用个人微信那份(text-only 渠道的完整集),
 * 只覆盖点名平台身份与入口的几句, 避免把「微信」写进外部系统的回执里。
 * 必须整包提供: /stop、鉴权失败等分支会直接读这些字段, 缺了就会抛错, 用户连
 * 一句报错都收不到(此前用强制类型转换掩盖过这个缺失)。
 */

import type { ImUiTextPack } from '../shared/types';
import { ui as textChannelUi } from '../wechat/uiText';

export const ui: ImUiTextPack = {
  ...textChannelUi,
  slash: {
    ...textChannelUi.slash,
    new: '🌱 已开新会话 — 之前的上下文清掉了, 从头聊。',
    help: `🤖 我能帮你做这些:

/new         开个新会话(清掉当前上下文)
/help        看看我会啥

有活儿在跑想让它停? 直接发 \`!stop\`, 我会中止当前执行并撤掉排队的消息。
模型、权限与工作目录跟随连接配置(设置 → IM 机器人 → 自定义渠道, 或伙伴 → 消息平台)。

平时直接发消息就行。`,
    unknownCommand: (cmd: string) =>
      `没认出 \`${cmd}\` 这个命令。我能听懂的: /new、/help; 想停就发 \`!stop\`。`,
    detachedBySlash: '🚪 接管结束了, 后续消息回到这条渠道的会话。',
    detachedByRevoke: '⚠️ 接管已在桌面端收回, 后续消息回到这条渠道的会话。',
    notAttached: '当前没有接管任何任务。',
  },
  agent: {
    ...textChannelUi.agent,
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? '当前供应商';
      const reason =
        missing === 'gateway-key'
          ? '需要先配置 Cindy AI Key'
          : missing === 'provider-key'
            ? '还没有配置该供应商的 API Key'
            : missing === 'provider-disconnected'
              ? '未连接或连接已失效'
              : `需要先登录 ${agentKind} 凭证`;
      const message = `⚠️ 当前会话使用供应商「${provider}」(${model}), ${reason}。`;
      return attached
        ? `${message}\n请在桌面端的 Settings → 模型供应商中修复认证后, 直接继续发送消息。`
        : `${message}\n修改连接的默认设置后直接继续发送消息即可。`;
    },
  },
  error: {
    ...textChannelUi.error!,
    agentUnsupported: '⚠️ 当前 Agent 不支持这条渠道需要的逐条权限确认, 请在桌面端换一个 Agent 后重试。',
    permissionModeUnsupported: '⚠️ 当前 Agent 无法使用这个权限模式, 请在桌面端调整后重试。',
  },
};
