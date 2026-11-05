import { PLUGIN_UI_MAX_BYTES, pluginUiRecord } from '@cindy/maker-shared';

interface PageOperations {
  current(): boolean;
  read(): Promise<unknown>;
  capabilities(): Promise<unknown>;
  invoke(input: unknown): Promise<unknown>;
  appearance(input: unknown): Promise<unknown>;
  visibility(input: unknown): Promise<unknown>;
}

/** Adapter for the existing isolated App sandbox; it never accepts a page-supplied view or instance. */
export function createPluginUiPageBridge(ops: PageOperations, options: { readOnly: boolean }) {
  let closed = false, sequence = 0;
  const pending = new Set<number>();
  let events: Array<{ seq: number; message: unknown }> = [];
  const assertCurrent = () => { if (closed || !ops.current()) throw new Error('UI_UNAVAILABLE'); };
  const run = async (op: unknown, input: unknown): Promise<unknown> => {
    if (op === 'read') return ops.read();
    if (op === 'capabilities') return ops.capabilities();
    if (op === 'appearance.read') return ops.appearance({ kind: 'read' });
    if (op === 'visibility.read') return ops.visibility({ kind: 'read' });
    if (options.readOnly) throw new Error('UI_UNAVAILABLE');
    if (op === 'invoke') return ops.invoke(input);
    if (op === 'visibility.set' && pluginUiRecord(input)) return ops.visibility({ kind: 'set', patch: input.patch });
    if (op === 'appearance.set' && pluginUiRecord(input))
      return ops.appearance({ kind: 'set', patch: input.patch, ifRevision: input.ifRevision });
    if (op === 'appearance.reset' && pluginUiRecord(input))
      return ops.appearance({ kind: 'reset', fields: input.fields, ifRevision: input.ifRevision });
    throw new Error('UI_UNAVAILABLE');
  };
  return {
    async handle(raw: unknown): Promise<unknown> {
      assertCurrent();
      if (!pluginUiRecord(raw)) throw new Error('UI_UNAVAILABLE');
      if (raw.op === 'poll') {
        if (!Number.isSafeInteger(raw.after) || (raw.after as number) < 0 || (raw.after as number) > sequence)
          throw new Error('UI_UNAVAILABLE');
        events = events.filter(event => event.seq > (raw.after as number));
        return events;
      }
      if (raw.op !== 'message' || !pluginUiRecord(raw.message) || raw.message.jsonrpc !== '2.0' ||
          raw.message.method !== 'cindy/ui' || !Number.isSafeInteger(raw.message.id) ||
          (raw.message.id as number) < 0 || !pluginUiRecord(raw.message.params)) throw new Error('UI_UNAVAILABLE');
      const id = raw.message.id as number;
      if (pending.has(id) || pending.size >= 16 || events.length + pending.size >= 64) throw new Error('UI_UNAVAILABLE');
      try { if (Buffer.byteLength(JSON.stringify(raw.message)) > PLUGIN_UI_MAX_BYTES) throw new Error('UI_UNAVAILABLE'); }
      catch { throw new Error('UI_UNAVAILABLE'); }
      pending.add(id);
      let message: unknown;
      try {
        const result = await run(raw.message.params.op, raw.message.params.input);
        message = { jsonrpc: '2.0', id, result };
      } catch {
        message = { jsonrpc: '2.0', id, error: { code: -32000, message: 'UI_UNAVAILABLE' } };
      } finally { pending.delete(id); }
      assertCurrent();
      events.push({ seq: ++sequence, message });
      return { ok: true };
    },
    dispose() { closed = true; events = []; },
  };
}
