/**
 * PendingReplies —— 钉钉文字交互的「等待回复」登记表。
 *
 * 机器人与 dws 两种连接方式都没有按钮卡片，权限确认 / 提问都靠「发一段提示,
 * 等主人回一句话」完成。本类只负责这件事的状态：每个 lane 至多一个等待者、
 * 超时、与多端共享决定（shared）合流、断线时统一拒绝。收发本身由调用方注入。
 */

interface PendingReply<T = unknown> {
  parse(text: string): T | null;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SharedReplyDecision<T> {
  result: Promise<T>;
  decide(value: T): boolean;
}

export interface PendingReplyCodes {
  alreadyPending: string;
  timeout: string;
}

export class PendingReplies {
  private readonly pending = new Map<string, PendingReply>();

  constructor(private readonly codes: PendingReplyCodes) {}

  async request<T>(
    userId: string,
    prompt: string,
    parse: (text: string) => T | null,
    timeoutMs: number,
    shared: SharedReplyDecision<T> | undefined,
    send: (prompt: string) => Promise<unknown>,
  ): Promise<T> {
    if (this.pending.has(userId)) {
      throw new Error(this.codes.alreadyPending);
    }
    let resolveReply!: (value: T) => void;
    let rejectReply!: (error: Error) => void;
    const reply = new Promise<T>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(userId);
      rejectReply(new Error(this.codes.timeout));
    }, timeoutMs);
    const entry: PendingReply<T> = {
      parse,
      resolve: (value) => {
        if (shared) shared.decide(value);
        else resolveReply(value);
      },
      reject: rejectReply,
      timer,
    };
    this.pending.set(userId, entry as PendingReply);
    if (shared) {
      void shared.result.then((value) => {
        if (this.pending.get(userId) === entry) this.pending.delete(userId);
        clearTimeout(timer);
        resolveReply(value);
      });
    }
    try {
      await send(prompt);
    } catch (error) {
      if (this.pending.get(userId) === entry) this.pending.delete(userId);
      clearTimeout(entry.timer);
      if (shared) return shared.result;
      throw error;
    }
    return reply;
  }

  /**
   * 入站文字先过这里。返回 true 表示消息已被等待者消费（含「无权回答被吞掉」
   * 与「解析失败继续等」），调用方不得再把它当普通消息处理。
   */
  tryResolve(userId: string, text: string, senderMayAnswer: boolean): boolean {
    const entry = this.pending.get(userId);
    if (!entry) return false;
    if (!senderMayAnswer) return true;
    const value = entry.parse(text);
    if (value === null) return true;
    this.pending.delete(userId);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  rejectAll(code: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(code));
    }
    this.pending.clear();
  }
}
