// A separate client process using Desktop's production HTTP/event adapters.
// No Electron window, credentials, input replay or task runtime is constructed.
import { createHostClient, startHostEventBridge } from '../../../desktop/src/main/host-delegation.ts';

const config = JSON.parse(process.argv[2]);
const client = createHostClient(config);
const emit = value => { if (process.connected) process.send(value); };
const stop = startHostEventBridge({ ...config,
  broadcast: payload => emit({ type: 'event', payload }),
  onInteractionRequest: payload => emit({ type: 'interaction', payload }),
  onConnectionState: state => emit({ type: 'connection', state }),
  onError: () => emit({ type: 'connection-error' }),
});
process.on('message', async message => {
  try { emit({ type: 'reply', id: message.id, result: await client.request(message.path, message.body) }); }
  catch (error) { emit({ type: 'reply', id: message.id, error: error.message }); }
});
const close = () => { stop(); if (process.connected) process.disconnect(); };
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('disconnect', stop);
