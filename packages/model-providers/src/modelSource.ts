/** Connection-owned discovery identity. Never inherited through public model metadata. */
export interface DiscoveredModelSource {
  kind: 'magpie';
  providerId: string;
  label?: string;
  discoveredName?: string;
  /** Opaque Main-issued receipt, not a credential or model routing key. */
  snapshotId?: string;
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function validDiscoveredModelSource(value: unknown): value is DiscoveredModelSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return s.kind === 'magpie' && text(s.providerId, 256)
    && (s.label === undefined || text(s.label, 4096))
    && (s.discoveredName === undefined || text(s.discoveredName, 1024))
    && (s.snapshotId === undefined || text(s.snapshotId, 128));
}

/** magpie_label is the gateway's explicit protocol marker; owned_by alone is generic OpenAI. */
export function discoveredMagpieSource(record: Record<string, unknown>): DiscoveredModelSource | undefined {
  if (!text(record.magpie_label, 4096) || !text(record.owned_by, 256)) return undefined;
  return {
    kind: 'magpie', providerId: record.owned_by,
    label: record.magpie_label,
    ...(text(record.display_name, 1024) ? { discoveredName: record.display_name } : {}),
  };
}

/** Labels remain display-only; a free-form label never changes the source or wire identity. */
export function modelSupplierLabel(source: DiscoveredModelSource | undefined): string | undefined {
  if (!validDiscoveredModelSource(source)) return undefined;
  const prefix = source.discoveredName && `${source.discoveredName} · `;
  return prefix && source.label?.startsWith(prefix) && source.label.slice(prefix.length).trim()
    ? source.label.slice(prefix.length).trim() : source.providerId;
}
