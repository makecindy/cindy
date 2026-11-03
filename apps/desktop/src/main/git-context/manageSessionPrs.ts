import { parseGithubPr, type SessionPrRef, type SessionPrRefAction } from '@cindy/maker-shared';
import { managePrRefs } from './prRefsStore';
import type { PrRef } from './prRefExtractor';

/** Public identities resolve to existing row IDs; no second association store. */
export async function manageSessionPrs(
  sessionId: string,
  args: Record<string, unknown>,
  verify: (pr: PrRef) => Promise<void>,
  origin: string,
): Promise<Record<string, unknown>> {
  const actions = ['list', 'attach', 'detach', 'restore', 'pin', 'unpin', 'reorder'];
  if (!actions.includes(String(args.action))) throw new Error('INVALID_ACTION');
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100)
  )
    throw new Error('INVALID_LIMIT');
  const limit =
    typeof args.limit === 'number' &&
    Number.isInteger(args.limit) &&
    args.limit >= 1 &&
    args.limit <= 100
      ? args.limit
      : 100;
  let offset = 0;
  if (args.after !== undefined) {
    if (typeof args.after !== 'string' || !/^\d+$/.test(args.after))
      throw new Error('INVALID_CURSOR');
    offset = Number(args.after);
    if (!Number.isSafeInteger(offset)) throw new Error('INVALID_CURSOR');
  }
  const rows = await managePrRefs(sessionId, { action: 'list' }, verify, origin);
  const find = (selector: unknown) => {
    const pr = parseGithubPr(selector);
    return rows.find(
      (row) =>
        row.owner.toLowerCase() === pr.owner &&
        row.repo.toLowerCase() === pr.repo &&
        row.prNumber === pr.prNumber,
    );
  };
  let result: SessionPrRef[] = rows;
  let operation: SessionPrRefAction | undefined;
  if (args.action === 'reorder') {
    if (!Array.isArray(args.prs) || args.prs.length > 2000) throw new Error('INVALID_ORDER');
    operation = {
      action: 'reorder',
      ids: args.prs.map((selector) => {
        const row = find(selector);
        if (!row) throw new Error('PR_ASSOCIATION_NOT_FOUND');
        return row.id;
      }),
    };
  } else if (args.action !== 'list') {
    const pr = parseGithubPr(args.pr);
    const row = find(args.pr);
    if (args.action === 'attach') {
      if (row?.removedAt != null) throw new Error('RESTORE_REQUIRED');
      operation = { action: 'add', url: pr.url };
    } else {
      if (!row) throw new Error('PR_ASSOCIATION_NOT_FOUND');
      operation = {
        action: args.action === 'detach' ? 'remove' : (args.action as 'restore' | 'pin' | 'unpin'),
        id: row.id,
      };
    }
  }
  if (operation) result = await managePrRefs(sessionId, operation, verify, origin);
  if (offset > result.length) throw new Error('INVALID_CURSOR');
  const end = Math.min(result.length, offset + limit);
  return {
    ok: true,
    session_id: sessionId,
    associations: result.slice(offset, end),
    has_more: end < result.length,
    next_cursor: end < result.length ? String(end) : null,
  };
}
