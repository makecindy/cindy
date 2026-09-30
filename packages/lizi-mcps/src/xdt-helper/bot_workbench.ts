import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴工作台:伙伴把自己正在跟进的工作写成几张卡片,宿主在伙伴对话页右侧渲染。
 *
 * 工具层只收数据,不收样式;界面由宿主的固定卡片组件决定。归属与
 * bot_skills 一致,由 host 从 callerSessionId 反查,不接受 botId 参数。
 */

export const WORKBENCH_MAX_CARDS = 4;
export const WORKBENCH_MAX_ROWS = 5;

const workbenchRowShape = z
  .object({
    title: z.string().min(1).max(60).describe('这一行是什么事,一句短语'),
    detail: z.string().max(80).optional().describe('补充说明:现状、数量或原因,一句话'),
    flag: z.boolean().optional().describe('确实需要主人注意时为 true(卡住、被退回、异常)'),
    status: z.string().min(1).max(12).optional().describe('这件事到了哪一步,如「review」「制作中」「已交付」'),
    action: z
      .object({
        label: z.string().min(1).max(8).describe('按钮文字,如「查原因」「批量修正」'),
        message: z
          .string()
          .min(1)
          .max(500)
          .describe('主人点按钮后,以主人身份发给你的那句话;写成你收到就能直接开始做的指令'),
      })
      .strict()
      .optional()
      .describe('主人点一下就能让你去做的事'),
  })
  .strict();

const workbenchCardShape = z
  .object({
    title: z.string().min(1).max(12).describe('卡片标题,按实际工作起名,如「进度」「资产」「待回复」'),
    source: z.string().max(24).optional().describe('这张卡来自哪个工作来源,写短名:目录名「Filo」或服务名「Gmail」,不要写文件路径'),
    rows: z.array(workbenchRowShape).max(WORKBENCH_MAX_ROWS),
  })
  .strict();

export type WorkbenchRowWire = z.infer<typeof workbenchRowShape>;
export type WorkbenchCardWire = z.infer<typeof workbenchCardShape>;

export interface BotWorkbenchCallbacks {
  update(params: {
    callerSessionId: string;
    cards: WorkbenchCardWire[];
  }): Promise<ControlResult<{ updatedAt: string; cardCount: number }, string>>;
}

export interface BotWorkbenchToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotWorkbenchCallbacks;
}

export function registerBotWorkbenchTools(
  registry: XdtHelperToolRegistry,
  deps: BotWorkbenchToolDeps,
): void {
  registry.register({
    name: 'update_workbench',
    category: 'bots',
    description:
      '更新你在对话右侧的工作台:几张卡片,让主人一眼看到你在跟进的工作。'
      + '进度、产出和工作目录由宿主自动显示,这里只写你对这份工作的理解。'
      + '主人交给你工作目录后,先自己快速看一遍(说明文档、最近提交与改动、目录结构)就调用,不要等全部看完,也不要为此开后台任务;'
      + '之后在连接了邮箱、日历等新来源,或做完一件会改变卡片内容的事时再更新。'
      + '每次传完整的 cards,会整体替换旧内容;传空数组表示清空。'
      + `最多 ${WORKBENCH_MAX_CARDS} 张卡,每张最多 ${WORKBENCH_MAX_ROWS} 行,只放最要紧的;卡片标题按这份工作实际起名,不要套固定名字。`
      + '每一行给 status(这件事到哪一步)或 action(主人能让你直接去做的事),二选一;你能动手解决的问题(修正、整理、起草、准备材料)优先给 action。'
      + 'flag 只标确实需要主人注意的行。只写你读到有依据的事实,不要编造。',
    inputShape: {
      cards: z.array(workbenchCardShape).max(WORKBENCH_MAX_CARDS),
    },
    handler: async ({ cards }) => {
      const sessionId = deps.getSessionContext().sessionId ?? null;
      if (!sessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务。');
      const invalid = cards
        .flatMap((card) => card.rows)
        .find((row) => Boolean(row.status) === Boolean(row.action));
      if (invalid) {
        return errorPayload(
          'INVALID_ROW',
          `「${invalid.title}」需要 status 或 action 其中一个,且不能同时给。`,
        );
      }
      const result = await deps.callbacks.update({ callerSessionId: sessionId, cards });
      return result.ok
        ? okPayload({ updatedAt: result.updatedAt, cardCount: result.cardCount })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
