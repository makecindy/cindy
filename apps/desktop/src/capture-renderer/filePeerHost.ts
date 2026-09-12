import { createFilePeerRuntime } from '@cindy/device-link';
import type { FilePeerHostApi } from '../shared/filePeer';

export function startFilePeerHost(api: FilePeerHostApi) {
  const runtime = createFilePeerRuntime(api);
  const off = api.onCommand((id, c) => {
    void (async () => {
      try {
        let result: string | undefined;
        switch (c.action) {
          case 'offer':
            result = await runtime.offer(c.connection, c.servers);
            break;
          case 'accept':
            result = await runtime.accept(c.connection, c.servers, c.sdp);
            break;
          case 'answer':
            await runtime.answer(c.connection, c.sdp);
            break;
          case 'receive':
            await runtime.receive(c.connection, c.ticket, c.size, c.sink);
            break;
          case 'close':
            runtime.close(c.connection);
            break;
        }
        await api.reply(id, true, result);
      } catch {
        await api.reply(id, false);
      }
    })();
  });
  void api.register();
  return () => {
    off();
    runtime.dispose();
  };
}
