import {HOST_ONLY_AGENT_PREFIX,type AgentInputQueuedMessage,type AgentInputCreateOpts} from '@cindy/maker-shared/agent-input-queue';
import {UI_ACTION_TRIGGER_PREFIX} from '@cindy/maker-shared/synthetic-trigger';
import {permissionModeOrAsk} from '@cindy/maker-shared/permission-mode';
import type {AgentRequestReceipt} from '@cindy/maker-shared/forwarded-request-types';
import type {BotTaskCoordination} from '@cindy/maker-shared/bot-task-coordination';
import {bindTaskActionInput,type TaskActionDeliveryGuard} from './taskActionAuthorization.js';
export function createSessionControlInputBuilder<Meta>(deps:{buildCreateOptsForQueuedSession(id:string,meta:Meta,inheritTargetPlanMode?:boolean):Promise<AgentInputCreateOpts>}){
const {buildCreateOptsForQueuedSession}=deps;
async function buildSessionControlInputItem(params: {
    taskActionDeliveryGuard?: TaskActionDeliveryGuard;
    botTaskCoordination?: BotTaskCoordination;
    targetSessionId: string;
    inheritTargetPlanMode?: boolean;
    message: string;
    persistedContent: string;
    clientId: string;
    meta: Meta;
    files?: AgentInputQueuedMessage['files'];
    origin?: AgentInputQueuedMessage['origin'];
    sourcePlugin?: AgentInputQueuedMessage['sourcePlugin'];
    /** Host-only receipt: plugin-authored input is not user-authored permission. */
    autoReviewUserText?: AgentRequestReceipt;
    toolsDisabled?: boolean;
  }): Promise<AgentInputQueuedMessage> {
    const createOpts = await buildCreateOptsForQueuedSession(params.targetSessionId, params.meta, params.inheritTargetPlanMode);
    const imageAttachments: NonNullable<AgentInputQueuedMessage['chatMessage']['images']> = [];
    for (const file of params.files ?? []) {
      if (file.category !== 'image') continue;
      if (file.url) {
        imageAttachments.push({
          url: file.url,
          mimeType: file.mimeType,
          originalName: file.originalName ?? file.name,
        });
        continue;
      }
      if (file.base64) {
        imageAttachments.push({
          base64: file.base64,
          mimeType: file.mimeType,
          originalName: file.originalName ?? file.name,
        });
      }
    }
    const fileAttachments = params.files?.flatMap((file) =>
      file.category !== 'image' && file.path ? [{ name: file.name, path: file.path }] : []);
    const persistedContent = params.files?.length
      ? JSON.stringify({
          text: params.persistedContent,
          images: imageAttachments.filter((image) => 'url' in image),
          files: fileAttachments,
        })
      : params.persistedContent;
    // 主机隐藏指令(任务回执等):落库行带 [UI_ACTION_TRIGGER] 前缀、发给模型的正文不带。
    // 排队行的遮蔽按 text 判定,所以 text 保留前缀,只在最终 wire 组装时去掉
    // (agentOmitsTriggerPrefix → buildMakerUserMessage)。
    const hiddenTriggerForAgent = !params.message.startsWith(UI_ACTION_TRIGGER_PREFIX)
      && params.persistedContent.startsWith(UI_ACTION_TRIGGER_PREFIX);
    // Group peer envelopes belong only to the current model dispatch. Keep the
    // safe authored body in queue text/history; the symbol never crosses JSON.
    const modelOnlyEnvelope = params.clientId.startsWith('bot-dm:') && hiddenTriggerForAgent
      && params.persistedContent !== `${UI_ACTION_TRIGGER_PREFIX}${params.message}`;
    const queued: AgentInputQueuedMessage = {
      clientId: params.clientId,
      text: modelOnlyEnvelope ? params.persistedContent
        : hiddenTriggerForAgent ? `${UI_ACTION_TRIGGER_PREFIX}${params.message}` : params.message,
      ...(modelOnlyEnvelope ? { [HOST_ONLY_AGENT_PREFIX]: params.message.slice(0, params.message.length - params.persistedContent.slice(UI_ACTION_TRIGGER_PREFIX.length).length) } : {}),
      ...(params.botTaskCoordination ? { botTaskCoordination: params.botTaskCoordination } : {}),
      ...(hiddenTriggerForAgent ? { agentOmitsTriggerPrefix: true as const } : {}),
      ...(params.autoReviewUserText !== undefined ? { autoReviewUserText: params.autoReviewUserText } : {}),
      ...(params.toolsDisabled === true ? { toolsDisabled: true } : {}),
      persistedContent,
      model: createOpts.model,
      effort: createOpts.effort ?? '',
      permissionMode: permissionModeOrAsk(createOpts.permissionMode),
      workingDir: createOpts.workingDir,
      vendorOptions: createOpts.vendorOptions,
      ...(params.files?.length ? { files: params.files } : {}),
      chatMessage: {
        clientId: params.clientId,
        role: 'user',
        content: params.persistedContent,
        createdAt: new Date().toISOString(),
        ...(imageAttachments.length ? { images: imageAttachments } : {}),
        ...(fileAttachments?.length ? { files: fileAttachments } : {}),
      },
      createOpts,
      ...(params.origin ? { origin: modelOnlyEnvelope && (params.origin.kind === 'session' || params.origin.kind === 'orca')
        ? { ...params.origin, displayText: params.persistedContent } : params.origin } : {}),
      ...(params.sourcePlugin ? { sourcePlugin: params.sourcePlugin } : {}),
    };
    bindTaskActionInput(params.targetSessionId, queued, params.taskActionDeliveryGuard);
    return queued;
  }
return buildSessionControlInputItem;
}
