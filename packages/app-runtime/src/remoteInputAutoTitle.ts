import {
  deriveAutoTitleSeed,
  type AgentInputQueuedMessage,
} from "@cindy/maker-shared/agent-input-queue";
import type { createSessionAutoTitle } from "./sessionAutoTitle.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
export function createRemoteInputAutoTitle(
  host: Pick<
    ReturnType<typeof createSessionAutoTitle>,
    "isSessionAutoTitleEligible" | "scheduleSessionAutoTitle"
  > & {
    isDeviceLinkInvoke(): boolean;
    labels(): { image: string; file: string };
    log: DbLogger;
  },
) {
  const {
    isDeviceLinkInvoke,
    isSessionAutoTitleEligible,
    scheduleSessionAutoTitle,
    log,
  } = host;
  const prepareDeviceLinkAutoTitle = async (
    sid: string,
    queued: AgentInputQueuedMessage,
  ): Promise<() => void> => {
    const noop = () => {};
    if (!isDeviceLinkInvoke()) return noop;
    // 起名素材:用户写了字就用他的字(可喂标题模型);一个字没写(只贴图 / 只拖
    // 文件 / 只 @ 一个文件 / 只引用一个会话)就用本地合成的描述,只当占位标题。
    const seed = deriveAutoTitleSeed(queued, host.labels());
    if (!seed) return noop;
    let eligible: boolean;
    try {
      eligible = await isSessionAutoTitleEligible(sid);
    } catch (err) {
      // 这一步只是省一次无谓调度的**廉价预检**,权威资格判定在
      // runSessionAutoTitle 内部(它自己也做重试安全的处理)。读不到时按"要起名"
      // 放行,否则一次 DB 抖动就会让单轮对话的标题永久停在 New Maker(review P1)。
      log.warn("[device-link] auto-title precheck failed (scheduling anyway)", {
        sessionId: sid,
        err: err instanceof Error ? err.message : String(err),
      });
      eligible = true;
    }
    if (!eligible) return noop;
    return () => {
      scheduleSessionAutoTitle({
        sessionId: sid,
        text: seed.text,
        agentKind: queued.createOpts.agentKind,
        isUserText: seed.isUserText,
      });
    };
  };

  return prepareDeviceLinkAutoTitle;
}
