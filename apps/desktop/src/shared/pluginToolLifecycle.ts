import type { ToolLifecycleVerdict } from '@cindy/maker-core/tool-lifecycle';

/** Native tool hook answers contain only supported control fields, never approval. */
export function parseToolLifecycleVerdict(value: unknown): ToolLifecycleVerdict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (raw.decision !== undefined && raw.decision !== 'deny' && raw.decision !== 'ask') return;
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return;
  if (raw.additionalContext !== undefined && typeof raw.additionalContext !== 'string') return;
  if (raw.input !== undefined && (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input))) return;
  try {
    const json = JSON.stringify(raw);
    if (json.length <= 1_048_576) return JSON.parse(json) as ToolLifecycleVerdict;
  } catch { /* Only bounded JSON crosses the existing plugin pipe. */ }
}
