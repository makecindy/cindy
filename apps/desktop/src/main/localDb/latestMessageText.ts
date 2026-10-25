import { createMessagePreviewReader } from '@cindy/runtime-db/messagePreviewReader';
/**
 * latestMessageText — 取会话 user / assistant 消息的纯文本素材。
 *
 * 与 messages:list 同一套可见性口径:只取 clearedAt 之后、未被 rewind 软删的消息,
 * 否则 /clear 过的会话会读到本该隐藏的旧内容。排序同样对齐 messages:list:
 * createdAt 相同(同毫秒批量落库)时以 rowid 保持写入顺序,避免 transcript 错序。
 *
 * 消费方:sessionTaskSummary(置顶卡片摘要素材,用 latestMessage)、maker-ipc/title
 * (重命名输入框 Magic 按钮按对话内容重起标题,用 regenerateTitleMaterial)。
 * 放在 localDb 层而不是 sessionTaskSummary,是为避免 maker-ipc → sessionTaskSummary
 * → maker-host/index → maker-ipc 的静态模块环。
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { extractText } from '../sessionTaskSummary.logic.js';

import { getDbClient } from './client/current.js';
import { extractMessagePreview } from './mapper.js';
import { messages, sessions } from './schema.js';
import {
  isTitleTurnBoundaryUser,
  isVisibleTitleUser,
  selectRecentTitleMessages,
  type TitleMessageCandidate,
} from './latestMessageText.logic.js';
import {createLatestMessageText} from '@cindy/app-runtime/latestMessageText';
export const {latestVisiblePreviewRow,latestVisiblePreview,latestMessage,latestMessageText,latestNonEmptyMessageText,regenerateTitleMaterial}=createLatestMessageText({getDbClient:()=>getDbClient(),extractMessagePreview:(...args)=>extractMessagePreview(...args)});
export type {LatestMessage,RecentMessage,OpeningMessage,RegenerateTitleMaterial,LatestVisiblePreviewRow} from '@cindy/app-runtime/latestMessageText';
