import { randomUUID } from 'node:crypto';

import type { IMHost } from '../types.js';
import {
  TelegramApiError,
  type TelegramApiClient,
  type TgCallbackQuery,
  type TgChat,
} from './api.js';

export class TelegramGroupAdmissionStorageError extends Error {}

type GroupDecision = {
  status: 'pending' | 'approved' | 'denied';
  token: string;
  title: string;
  inviter?: string;
  notified?: boolean;
  membershipUpdateId?: number;
};

/** Connection-local, mandatory admission. No model or permission-mode decision can grant it. */
export class TelegramGroupAdmission {
  private groups: Record<string, GroupDecision> = Object.create(null);
  private readonly noticeAttempts = new Map<string, number>();

  constructor(
    private readonly secrets: IMHost['secrets'],
    private readonly key: string,
    private readonly identity: string,
    private readonly ownerId: string,
  ) {
    try {
      const saved = JSON.parse(secrets.read(key) ?? 'null');
      if (
        saved?.identity !== identity ||
        !saved.groups ||
        typeof saved.groups !== 'object'
      )
        return;
      for (const [id, raw] of Object.entries(saved.groups)) {
        const entry = raw as GroupDecision;
        if (
          /^-\d+$/.test(id) &&
          entry &&
          ['pending', 'approved', 'denied'].includes(entry.status) &&
          typeof entry.token === 'string' &&
          typeof entry.title === 'string'
        ) {
          this.groups[id] = entry;
        }
      }
    } catch {
      // Missing/unreadable state never grants access to existing groups.
    }
  }

  allows(chatId: number): boolean {
    return !!this.ownerId && this.groups[String(chatId)]?.status === 'approved';
  }

  private save(next: Record<string, GroupDecision>): boolean {
    try {
      if (
        !this.secrets.write(
          this.key,
          JSON.stringify({ identity: this.identity, groups: next }),
        )
      )
        return false;
    } catch {
      return false;
    }
    this.groups = next;
    return true;
  }

  membership(
    chat: TgChat,
    joined: boolean,
    invitedByOwner: boolean,
    updateId: number,
    inviter: string,
  ): void {
    const id = String(chat.id);
    if (this.groups[id]?.membershipUpdateId === updateId) return;
    const entry: GroupDecision = {
      status: joined
        ? invitedByOwner && this.ownerId
          ? 'approved'
          : 'pending'
        : 'denied',
      token: randomUUID(),
      title: chat.title ?? id,
      membershipUpdateId: updateId,
      inviter,
    };
    // Rejoining requires a fresh invitation/approval; old buttons must not activate it.
    const next = { ...this.groups, [id]: entry };
    if (!this.save(next)) {
      // Do not remember this update as committed: the same event must be retried after recovery.
      this.groups = {
        ...next,
        [id]: { ...entry, status: 'denied', membershipUpdateId: undefined },
      };
      throw new TelegramGroupAdmissionStorageError(
        'telegram group admission could not be saved',
      );
    }
    this.noticeAttempts.delete(id);
  }

  clear(): boolean {
    this.groups = Object.create(null);
    try {
      this.secrets.remove(this.key);
      return this.secrets.readResult?.(this.key).kind === 'missing';
    } catch {
      return false;
    }
  }

  private call(
    api: TelegramApiClient,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return api.call(
      method,
      params,
      AbortSignal.any([signal, AbortSignal.timeout(4_500)]),
    );
  }

  notifyMembership(
    api: TelegramApiClient,
    text: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.call(
      api,
      'sendMessage',
      { chat_id: this.ownerId, text },
      signal,
    );
  }

  async request(
    chat: TgChat,
    api: TelegramApiClient,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.ownerId || !isCurrent()) return;
    const id = String(chat.id);
    let entry = this.groups[id];
    if (!entry) {
      entry = {
        status: 'pending',
        token: randomUUID(),
        title: chat.title ?? id,
      };
      if (!this.save({ ...this.groups, [id]: entry })) return;
    }
    if (entry.status !== 'pending' || entry.notified === true) return;
    const last = this.noticeAttempts.get(id);
    if (last !== undefined && Date.now() < last) return;
    this.noticeAttempts.set(id, Date.now() + 60_000);
    try {
      await this.call(
        api,
        'sendMessage',
        {
          chat_id: this.ownerId,
          text: `群「${entry.title.slice(0, 200)}」等待你批准（chat_id: ${id}）。\n${entry.inviter ? `邀请人 / Invited by: ${entry.inviter.slice(0, 200)}。` : '无法确认原邀请人 / Original inviter unknown.'}\n批准后，群成员可以召唤此机器人并使用你的模型额度。批准前只响应你本人，其他成员的消息不会进入 AI 或群上下文。\nApproving lets group members use this bot and your model quota. Until then, only your own messages are accepted; other messages are not sent to AI or saved as group context.`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '批准 / Approve',
                  callback_data: `ga:y:${entry.token}`,
                },
                { text: '拒绝 / Deny', callback_data: `ga:n:${entry.token}` },
              ],
            ],
          },
        },
        signal,
      );
      if (isCurrent() && this.groups[id] === entry) {
        this.save({ ...this.groups, [id]: { ...entry, notified: true } });
      }
    } catch (err) {
      if (
        err instanceof TelegramApiError &&
        err.errorCode === 429 &&
        isCurrent()
      ) {
        this.noticeAttempts.set(
          id,
          Math.max(
            this.noticeAttempts.get(id) ?? 0,
            Date.now() + (err.retryAfterSec ?? 0) * 1_000,
          ),
        );
      }
      // A later incoming event can retry a failed notice; no background polling.
    }
  }

  async handleCallback(
    q: TgCallbackQuery,
    api: TelegramApiClient,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!q.data?.startsWith('ga:')) return false;
    const answer = async (text: string) => {
      await this.call(
        api,
        'answerCallbackQuery',
        {
          callback_query_id: q.id,
          text,
          show_alert: true,
        },
        signal,
      ).catch(() => undefined);
    };
    if (
      !isCurrent() ||
      String(q.from.id) !== this.ownerId ||
      q.message?.chat.type !== 'private' ||
      String(q.message.chat.id) !== this.ownerId
    ) {
      await answer(
        '仅绑定用户可在私聊中批准。Only the linked user can approve in a private chat.',
      );
      return true;
    }
    const match = /^ga:([yn]):(.+)$/.exec(q.data);
    const found =
      match &&
      Object.entries(this.groups).find(
        ([, entry]) => entry.token === match[2] && entry.status === 'pending',
      );
    if (!found) {
      await answer('此请求已失效。This request has expired.');
      return true;
    }
    const [id, entry] = found;
    const approved = match![1] === 'y';
    if (
      !this.save({
        ...this.groups,
        [id]: { ...entry, status: approved ? 'approved' : 'denied' },
      })
    ) {
      await answer(
        '未能保存，群仍未启用，请重试。Could not save. The group is still disabled; please retry.',
      );
      return true;
    }
    const text = approved ? '已批准 / Approved' : '已拒绝 / Denied';
    // Persist before acknowledging. Failed rendering never undoes the decision.
    const edited = this.call(
      api,
      'editMessageText',
      {
        chat_id: this.ownerId,
        message_id: q.message.message_id,
        text: `群「${entry.title.slice(0, 200)}」（chat_id: ${id}）：${text}`,
        reply_markup: { inline_keyboard: [] },
      },
      signal,
    ).catch(() => undefined);
    await Promise.all([answer(text), edited]);
    return true;
  }
}
