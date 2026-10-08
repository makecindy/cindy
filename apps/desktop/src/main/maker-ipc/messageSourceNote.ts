import {
  buildMessageSourceNote,
  messageSourceSenderFromMeta,
  readMessageSourceDevice,
  readMessageSourcePlugin,
  type MessageSourceDevice,
  type MessageSourcePlugin,
} from '@cindy/maker-shared/message-source';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';

/**
 * 发给模型的 `[消息来源]` 说明(谁发的:任务 / 伙伴 / 插件 / 共享任务成员)。
 *
 * 与界面来源标签读同一份主机盖章的数据(落库 agentMeta 的 origin / sourcePlugin /
 * sharedTaskAuthor),只在**派发那一刻**前置到 wire 消息上:不进队列 `text`、
 * `persistedContent`、落库正文、系统提示词,也不进 `getAgentFacingText`(它同时
 * 服务自动起名与 Ghost 钩子)。每条投递路径只在最终派发处加一次:
 *  - 排队 → send 事务(makerSendTransaction);
 *  - 同轮插话(steerToAgentAccepted);
 *  - 空闲直发(sendUserMessageWithAwaitedGitBaseline)。
 *
 * 来源只用于归属,**不是**信任 / 权限判据;说明只陈述事实,怎么处理交给模型。
 */
export interface WireMessageSourceFields {
  origin?: unknown;
  sourcePlugin?: unknown;
  sharedTaskAuthor?: unknown;
}

/**
 * 返回本条消息的 `[消息来源]`;本机用户亲手输入返回 null。
 *
 * 主机生成的隐藏指令(`[UI_ACTION_TRIGGER]` 续跑 / 回执)与自动续跑不是来源方发的话,
 * 即使它们沿用了原条目的 origin 也不加说明。
 */
export function buildWireMessageSourceNote(
  fields: WireMessageSourceFields | undefined,
  opts: { visibleText?: string; autoResume?: boolean } = {},
): string | null {
  if (!fields || opts.autoResume) return null;
  if (opts.visibleText !== undefined && isSyntheticTriggerText(opts.visibleText.trimStart()))
    return null;
  return buildMessageSourceNote(messageSourceSenderFromMeta(fields));
}

/** 宽容读取主机透传的设备来源(未知平台 / 缺 id 返回 undefined)。 */
export function readWireSourceDevice(value: unknown): MessageSourceDevice | undefined {
  return readMessageSourceDevice({ sourceDevice: value });
}

/** 宽容读取主机透传的插件来源。 */
export function readWireSourcePlugin(value: unknown): MessageSourcePlugin | undefined {
  return readMessageSourcePlugin({ sourcePlugin: value });
}
