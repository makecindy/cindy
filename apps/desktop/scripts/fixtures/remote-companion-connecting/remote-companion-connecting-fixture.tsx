/** Isolated test adapter: no real account, relay, device directory, messages or takeover. */
import { Route, Routes } from 'react-router-dom';
import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { RemoteBotSessionView } from '../../../src/renderer/features/bots/RemoteBotSessionView';

void mountPage({
  route: '/bots/remote/home/writer',
  host: () => ({
    deviceLink: {
      // Just launched: the relay is still connecting and the directory read has not answered.
      getState: async () => ({ linkStatus: 'connecting' }),
      listDevices: () => new Promise(() => undefined),
      onStatusChanged: subscription('deviceLinkStatus'),
      onPresenceChanged: subscription('deviceLinkPresence'),
      onControlTargetChanged: subscription('deviceLinkControlTarget'),
      onDeviceDirectoryInvalidated: subscription('deviceLinkDirectoryInvalidated'),
      invoke: forbid('deviceLink.invoke'),
    },
  }),
  render: () => (
    <AppFrame>
      <Routes>
        <Route path="/bots/remote/:deviceId/:botId" element={<RemoteBotSessionView />} />
      </Routes>
    </AppFrame>
  ),
});
