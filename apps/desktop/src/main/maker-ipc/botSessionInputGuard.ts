export interface BotSessionInputSnapshot {
  source: string;
  role: string | null;
  profileStatus: string | null;
}

export function botSessionInputBlockReason(
  snapshot: BotSessionInputSnapshot | null,
): string | null {
  if (!snapshot || snapshot.source !== 'bot') return null;
  if (!snapshot.role || !snapshot.profileStatus) {
    return 'Bot 任务的归属信息不完整，无法继续发送消息';
  }
  if (snapshot.role === 'history') {
    return 'Bot 历史任务为只读，不能继续发送消息';
  }
  if (snapshot.profileStatus !== 'active') {
    return 'Bot 当前未启用，请先恢复 Bot 后再发送消息';
  }
  return null;
}
