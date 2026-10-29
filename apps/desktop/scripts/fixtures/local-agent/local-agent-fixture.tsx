import { mountPage, subscription } from '../../ui-page/harness';
import { LocalAgentSection } from '../../../src/renderer/components/settings/LocalAgentSection';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

mountPage({
  host: ctx => ({
    localAgent: {
      developerConnection: async () => {
        if (ctx.data.copyExpired && (window as any).__copyRequested) return { state: 'stopped' };
        return ctx.data.developer ?? null;
      },
      onConnectionsChanged: subscription('localAgentChanged'),
      connections: async () => {
        if (ctx.data.loadFailed) throw new Error('fixture connection read failed');
        return ctx.data.connections ?? [];
      },
      setCreateVisibleSessions: async (id: string, enabled: boolean) => {
        if (ctx.data.saveFailed) throw new Error('fixture setting write failed');
        const connection = ctx.data.connections?.find((entry: { id: string }) => entry.id === id);
        if (!connection) return false;
        connection.createVisibleSessions = enabled;
        return true;
      },
      revoke: async (id: string) => {
        if (id !== ctx.data.connections?.[0]?.id) throw new Error('wrong connection selected');
        if (ctx.data.revokeFailed) throw new Error('fixture revoke failed');
        return !ctx.data.cancel;
      },
    },
  }),
  render: () => <><div className="mx-auto w-full max-w-3xl p-5"><LocalAgentSection /></div><ToastContainer /></>,
});
