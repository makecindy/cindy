import { WindowConfirmationBridge } from '../../desktop/src/main/windowConfirmationBridge.js';
import type { GhostConfirmPush } from '../../desktop/src/main/cindy-brain/ghostConfirmDialogBridge.js';
import type { GhostInstallConsentRequest } from '../../desktop/src/shared/ghostInstallConsent.js';

type Confirm = Omit<GhostConfirmPush, 'requestId'>;
type Install = Omit<GhostInstallConsentRequest, 'requestId'>;
interface Event { type: 'plugin_push'; channel: string; payload: unknown }

/** Delivery adapter for the existing Host confirmation UI. The HTTP transport
 * supplies the authenticated controller identity; plugin pages never do. These
 * pending dialogs are transient and do not confer or persist approval. */
export function createHostConfirmations(options: { current(): boolean }) {
  const confirms = new WindowConfirmationBridge<Confirm>();
  const installs = new WindowConfirmationBridge<Install>();
  const connections = new Map<number, { caller: string; send(event: Event): boolean }>();
  const requests = new Map<string, Set<AbortController>>();
  let sequence = 0;
  let closed = false;
  const current = () => !closed && options.current();

  async function request(pluginId: string, kind: 'confirm' | 'install', payload: Confirm | Install): Promise<boolean> {
    if (!current()) return false;
    const connection = [...connections].at(-1);
    if (!connection) return false;
    const [id, target] = connection;
    const abort = new AbortController();
    const pending = requests.get(pluginId) ?? new Set<AbortController>();
    requests.set(pluginId, pending); pending.add(abort);
    const channel = kind === 'confirm' ? 'ghosts:confirm' : 'ghosts:install-consent';
    const window = {
      id,
      send: (value: (Confirm | Install) & { requestId: string }) => current() && connections.get(id) === target
        && target.send({ type: 'plugin_push', channel: `${channel}${kind === 'confirm' ? '-request' : ':request'}`, payload: value }),
      dismiss: (requestId: string) => { target.send({ type: 'plugin_push', channel: `${channel}${kind === 'confirm' ? '-dismissed' : ':dismissed'}`, payload: { requestId } }); },
    };
    try {
      const answer = kind === 'confirm'
        ? await confirms.request(window, payload as Confirm, { signal: abort.signal })
        : await installs.request(window, payload as Install, { signal: abort.signal, key: `task-capability:${pluginId}` });
      return answer && current();
    } catch { return false; }
    finally {
      pending.delete(abort);
      if (!pending.size && requests.get(pluginId) === pending) requests.delete(pluginId);
    }
  }

  function cancelCaller(caller: string): void {
    for (const [id, connection] of connections) {
      if (connection.caller !== caller) continue;
      connections.delete(id); confirms.cancelRequester(id); installs.cancelRequester(id);
    }
  }

  return {
    connect(caller: string, send: (event: Event) => boolean): () => void {
      if (!current() || !caller) return () => {};
      const id = ++sequence;
      connections.set(id, { caller, send });
      return () => { connections.delete(id); confirms.cancelRequester(id); installs.cancelRequester(id); };
    },
    confirm: (payload: Confirm) => request(payload.ghostId, 'confirm', payload),
    install: (payload: Install) => request(payload.facts.ghostId, 'install', payload),
    resolve(caller: string, kind: 'confirm' | 'install', id: string, confirmed: unknown): boolean {
      if (!current()) return false;
      const bridge = kind === 'confirm' ? confirms : installs;
      for (const [requester, connection] of connections)
        if (connection.caller === caller && bridge.resolve(requester, id, confirmed)) return true;
      return false;
    },
    cancelCaller,
    cancelPlugin(id: string): void { for (const abort of requests.get(id) ?? []) abort.abort(); },
    close(): void { closed = true; confirms.cancelAll(); installs.cancelAll(); connections.clear(); },
  };
}
