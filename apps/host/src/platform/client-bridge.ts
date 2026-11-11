import { WebSocket } from 'ws';
import { createHostPlatformRpc } from '@cindy/maker-shared/host-platform-rpc';
import { createPlatformClientHandoff } from './client-handoff.mjs';

/** One bridge per account runtime. The bearer-authenticated socket is additionally
 * pinned to the Host instance by server.mjs. Browser cookies cannot attach. */
export function createPlatformClientBridge(options: { assertCurrent(): void; ownerId: string; uploadRoots?(id: string): Promise<string[]> }) {
  let current: { id: string; pid: number; socket: WebSocket } | null = null;
  let attaching = false;
  const gate = createPlatformClientHandoff({ assertCurrent: options.assertCurrent,
    isRetired: async ({ pid }: { pid: number }) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    },
  });
  return {
    call: gate.call,
    cleanupSession: gate.cleanupSession,
    status: gate.status,
    async accept(socket: WebSocket) {
      options.assertCurrent();
      if (attaching) throw Error('PLATFORM_CLIENT_ATTACHING');
      attaching = true;
      let rpc: ReturnType<typeof createHostPlatformRpc> | undefined;
      const deadline = setTimeout(() => socket.terminate(), 5000);
      deadline.unref();
      try {
        if (current) {
          if (current.socket.readyState !== WebSocket.CLOSED) throw Error('PLATFORM_CLIENT_ALREADY_ATTACHED');
        }
        rpc = createHostPlatformRpc(socket, { assertCurrent: options.assertCurrent,
          execute: async (operation: any) => {
            options.assertCurrent();
            if (operation?.method !== 'browser.uploadRoots' || typeof operation.sessionId !== 'string') throw Error('PLATFORM_OPERATION_INVALID');
            const roots = await options.uploadRoots?.(operation.sessionId) ?? [];
            options.assertCurrent(); return roots;
          },
        });
        const identity = await rpc.call({ method: 'identity', ownerId: options.ownerId }) as { id: string; pid: number; protocol: number; frozen?: boolean };
        options.assertCurrent();
        if (identity?.protocol !== 1 || !/^[a-zA-Z0-9-]{1,128}$/.test(identity.id)
          || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || socket.readyState !== WebSocket.OPEN)
          throw Error('PLATFORM_CLIENT_INVALID');
        const selected = { ...identity, socket };
        // Both ends live on this machine. Refuse an already-exited executor.
        process.kill(identity.pid, 0);
        const executor = { ...identity, call: rpc.call,
          canDetach: () => rpc!.call({ method: 'freeze' }),
          resume: () => rpc!.call({ method: 'resume' }),
        };
        if (current?.id === identity.id && current.pid === identity.pid) {
          gate.reconnect(executor, identity.frozen === true);
        } else {
          if (current) { await gate.retireLost(current); current = null; }
          gate.attach(executor);
        }
        current = selected;
        socket.once('close', () => {
          try { if (current === selected) gate.lost(selected); } catch { /* owner already closed */ }
        });
      } catch (error) { rpc?.close(); socket.terminate(); throw error; }
      finally { clearTimeout(deadline); attaching = false; }
    },
    async control(action: string, identity: { id: string; pid: number }) {
      options.assertCurrent();
      if (action === 'status') return { ...gate.status(), client: current && { id: current.id, pid: current.pid } };
      if (action === 'prepare') return gate.prepare(identity);
      if (action === 'cancel') { await gate.cancel(identity); return { resumed: true }; }
      throw Error('PLATFORM_CONTROL_INVALID');
    },
    close() { gate.close(); current?.socket.terminate(); current = null; },
  };
}
