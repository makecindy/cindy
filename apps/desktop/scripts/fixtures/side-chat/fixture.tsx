import { mountPage, subscription } from '../../ui-page/harness';
import { SideChatTabBody } from '../../../src/renderer/features/right-sidebar/plugins/side-chat/SideChatTabBody';
import type { TabKindHostContext } from '../../../src/renderer/features/right-sidebar/types';

mountPage({
  route: "/cc-agent/parent",
  host: () => ({
    localDb: {
      sessions: { get: async () => ({ id: 'child', parentSessionId: 'parent', source: 'side-chat', status: 'active', orcaRole: null }) },
      sessionsPush: { onPatched: subscription('patched') },
    },
    maker: { promoteSideChat: async () => { document.body.dataset.promoted = 'true'; } },
  }),
  render: () => <div style={{ height: '100vh' }}>
    <SideChatTabBody state={{ sessionId: 'child', deviceId: null }} active ctx={{
      sessionId: 'parent', tabId: 'side-chat', setCloseInterceptor: () => () => {},
    } as unknown as TabKindHostContext} />
  </div>,
});
