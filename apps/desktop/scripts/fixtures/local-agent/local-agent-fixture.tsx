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
      revoke: async (id: string) => {
        if (id !== ctx.data.connections?.[0]?.id) throw new Error('wrong connection selected');
        if (ctx.data.revokeFailed) throw new Error('fixture revoke failed');
        return !ctx.data.cancel;
      },
    },
  }),
  render: () => <><div className="mx-auto w-full max-w-3xl p-5"><LocalAgentSection /></div><ToastContainer /></>,
});
