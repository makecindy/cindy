/**
 * 运行设备上的「协同远端 Worker」标记(sessions.orca_remote_lead 的 JSON 形态)。
 *
 * 任务、目录与命令都在本机；派活的 Lead 与团队在另一台电脑。它在侧栏照常显示并标注来源，
 * 不能再开启协同、不能复制到其他电脑。main / renderer 共用，必须保持 renderer-safe。
 */
export interface OrcaRemoteLead {
  /** 派活电脑的设备 id(server 盖章的 src，不采信载荷自报)。 */
  leadDeviceId: string;
  /** 派活电脑的展示名快照，只用于归属展示。 */
  leadDeviceName: string;
  leadSessionId: string;
  leadTitle: string;
  workerLabel: string;
  /** 派活电脑通知结束协同的时刻(unix ms)；缺省 = 协同仍在进行。 */
  releasedAt?: number;
}

/** Lead 侧待回报身份；仅保存消息身份，不重发消息正文。 */
export interface OrcaRemotePendingReport {
  clientIds: string[];
  baselineMessageId: string | null;
}

const MAX_TEXT = 200;

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** 宽松解析：损坏或缺字段时返回 null(按普通任务处理)，不抛错。 */
export function parseOrcaRemoteLead(raw: unknown): OrcaRemoteLead | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const leadDeviceId = text(record.leadDeviceId, 128);
  const leadSessionId = text(record.leadSessionId, 128);
  const workerLabel = text(record.workerLabel, 32);
  if (!leadDeviceId || !leadSessionId || !workerLabel) return null;
  const releasedAt =
    typeof record.releasedAt === 'number' && Number.isFinite(record.releasedAt)
      ? record.releasedAt
      : undefined;
  return {
    leadDeviceId,
    leadDeviceName: text(record.leadDeviceName) ?? '',
    leadSessionId,
    leadTitle: text(record.leadTitle) ?? '',
    workerLabel,
    ...(releasedAt !== undefined ? { releasedAt } : {}),
  };
}

export function serializeOrcaRemoteLead(lead: OrcaRemoteLead): string {
  return JSON.stringify(lead);
}
