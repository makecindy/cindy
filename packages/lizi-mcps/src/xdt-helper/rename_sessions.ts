import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { decodeConfirmationToken, encodeConfirmationToken } from './_confirmation_token.js';
import { errorPayload, okPayload } from './_payload.js';

const MAX_RENAME_BATCH_SIZE = 20;
const TITLE_MAX_LENGTH = 120;

export interface RenameSessionChange {
  sessionId: string;
  title: string;
  expectedCurrentTitle?: string;
  expectedUpdatedAt?: string;
}

export interface RenameSessionPreviewItem {
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}

export type RenameSessionsResult = ControlResult<
  {
    changes: RenameSessionPreviewItem[];
  },
  'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INVALID_ARGS' | 'HOST_NOT_READY' | 'INTERNAL'
>;

export interface RenameSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  renameSessions(params: {
    changes: RenameSessionChange[];
    dryRun: boolean;
  }): Promise<RenameSessionsResult>;
}

interface RenameSessionsConfirmationPayload {
  v: 1;
  changes: Array<{
    sessionId: string;
    title: string;
    expectedCurrentTitle: string | null;
    expectedUpdatedAt: string | null;
    approvedCurrentTitle: string | null;
  }>;
}

const DESCRIPTION =
  `批量更改 ${BRAND_NAME} 历史对话/session 的标题。适合用户明确要求整理或批量重命名历史对话时使用。` +
  '必须先 dry_run 预览待改列表并把 confirmation_token 展示/核对清楚;真正写入时传 dry_run=false 和同一批变更对应的 token。' +
  '建议先用 history/list_sessions 找到目标 session_id;工具写入前会按预览标题自动加 expected_current_title 防止覆盖用户刚改过的标题,只有调用方显式传 expected_updated_at 时才校验 updatedAt。';

const changeSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .describe('要改名的目标 session id。建议来自 list_sessions 返回的 id。'),
  title: z
    .string()
    .min(1)
    .max(TITLE_MAX_LENGTH)
    .describe('新的标题。会 trim 并折叠连续空白,最长 120 字符。'),
  expected_current_title: z
    .string()
    .optional()
    .describe('可选前置条件: 仅当当前标题仍等于该值时才允许改名。'),
  expected_updated_at: z
    .string()
    .optional()
    .describe('可选前置条件: 仅当当前 updatedAt 仍等于该 ISO 时间时才允许改名。'),
});

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

function normalizeChange(input: z.infer<typeof changeSchema>): RenameSessionChange {
  return {
    sessionId: input.session_id,
    title: normalizeTitle(input.title),
    expectedCurrentTitle: input.expected_current_title,
    expectedUpdatedAt: input.expected_updated_at,
  };
}

function createConfirmationPayload(
  changes: RenameSessionChange[],
  previewChanges: RenameSessionPreviewItem[],
): RenameSessionsConfirmationPayload {
  const previewById = new Map(previewChanges.map((change) => [change.sessionId, change]));
  return {
    v: 1,
    changes: changes.map((change) => ({
      sessionId: change.sessionId,
      title: change.title,
      expectedCurrentTitle: change.expectedCurrentTitle ?? null,
      expectedUpdatedAt: change.expectedUpdatedAt ?? null,
      approvedCurrentTitle: previewById.get(change.sessionId)?.currentTitle ?? null,
    })),
  };
}

function isRenameConfirmationPayload(
  payload: unknown,
): payload is RenameSessionsConfirmationPayload {
  const p = payload as Partial<RenameSessionsConfirmationPayload> | null;
  if (!p || p.v !== 1 || !Array.isArray(p.changes)) return false;
  for (const change of p.changes) {
    if (
      typeof change?.sessionId !== 'string' ||
      typeof change.title !== 'string' ||
      (change.expectedCurrentTitle !== null && typeof change.expectedCurrentTitle !== 'string') ||
      (change.expectedUpdatedAt !== null && typeof change.expectedUpdatedAt !== 'string') ||
      (change.approvedCurrentTitle !== null && typeof change.approvedCurrentTitle !== 'string')
    ) {
      return false;
    }
  }
  return true;
}

function matchesConfirmationPayload(
  changes: RenameSessionChange[],
  payload: RenameSessionsConfirmationPayload,
): boolean {
  if (changes.length !== payload.changes.length) return false;
  return changes.every((change, index) => {
    const approved = payload.changes[index];
    return (
      approved?.sessionId === change.sessionId &&
      approved.title === change.title &&
      approved.expectedCurrentTitle === (change.expectedCurrentTitle ?? null) &&
      approved.expectedUpdatedAt === (change.expectedUpdatedAt ?? null)
    );
  });
}

function toPayloadChange(change: RenameSessionPreviewItem): Record<string, unknown> {
  return {
    session_id: change.sessionId,
    current_title: change.currentTitle,
    new_title: change.newTitle,
    working_dir: change.workingDir,
    updated_at: change.updatedAt,
  };
}

export function registerRenameSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: RenameSessionsDeps,
): void {
  registry.register({
    name: 'rename_sessions',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      changes: z
        .array(changeSchema)
        .min(1)
        .max(MAX_RENAME_BATCH_SIZE)
        .describe('要改名的 session 列表。一次最多 20 个。'),
      dry_run: z
        .boolean()
        .default(true)
        .describe('默认 true: 只预览不写库。false 时必须传 confirmation_token。'),
      confirmation_token: z
        .string()
        .optional()
        .describe('dry_run 返回的确认 token。dry_run=false 时必填且必须匹配同一批变更。'),
    },
    handler: async ({ changes, dry_run, confirmation_token }) => {
      const normalized = changes.map(normalizeChange);
      const blank = normalized.find((change) => !change.title);
      if (blank) {
        return errorPayload(
          'INVALID_ARGS',
          `session ${blank.sessionId} 的 title 不能是空白字符串。`,
        );
      }

      const duplicate = findDuplicateSessionId(normalized);
      if (duplicate) {
        return errorPayload('INVALID_ARGS', `同一次调用里 session_id 重复: ${duplicate}。`);
      }

      const confirmationPayload =
        !dry_run && confirmation_token
          ? decodeConfirmationToken(confirmation_token, isRenameConfirmationPayload)
          : null;
      if (
        !dry_run &&
        (!confirmationPayload || !matchesConfirmationPayload(normalized, confirmationPayload))
      ) {
        return errorPayload(
          'CONFIRMATION_REQUIRED',
          '批量改名需要先 dry_run=true 预览;确认后用同一批 changes 加 dry_run=false 和返回的 confirmation_token 重试。',
        );
      }

      if (dry_run) {
        const result = await deps.renameSessions({
          changes: normalized,
          dryRun: true,
        });

        if (!result.ok) {
          return mapRenameSessionsError(result);
        }
        const token = encodeConfirmationToken(
          createConfirmationPayload(normalized, result.changes),
        );

        return okPayload({
          dry_run,
          confirmation_token: token,
          changes: result.changes.map(toPayloadChange),
        });
      }

      const sessionCtx = deps.getSessionContext();
      if (!sessionCtx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `批量改名写入需要绑定到当前 ${BRAND_NAME} session,但本次 MCP 调用没有 session 上下文。`,
        );
      }

      const approvedChanges = normalized.map((change, index) => {
        const approved = confirmationPayload!.changes[index];
        return {
          ...change,
          expectedCurrentTitle: change.expectedCurrentTitle ?? approved.approvedCurrentTitle ?? undefined,
          expectedUpdatedAt: change.expectedUpdatedAt,
        };
      });

      const result = await deps.renameSessions({
        changes: approvedChanges,
        dryRun: false,
      });

      if (!result.ok) {
        return mapRenameSessionsError(result);
      }

      return okPayload({
        dry_run,
        changes: result.changes.map(toPayloadChange),
      });
    },
  });
}

function mapRenameSessionsError(result: RenameSessionsResult & { ok: false }) {
  if (result.errorCode === 'HOST_NOT_READY') {
    return errorPayload(
      'HOST_NOT_READY',
      `${BRAND_NAME} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`,
    );
  }
  return errorPayload(result.errorCode, result.message);
}

function findDuplicateSessionId(changes: RenameSessionChange[]): string | null {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.sessionId)) return change.sessionId;
    seen.add(change.sessionId);
  }
  return null;
}
