import { McpUiResourceTeardownResultSchema } from '@modelcontextprotocol/ext-apps';

const key = 'cindy/composer-attachment';
const failure = code => Object.assign(new Error(code), { code });

/** Add one resource to the local task composer without sending it to the model. */
export function addToComposer(app, input) {
  const capability = app?.getHostCapabilities?.()?.experimental?.[key];
  if (!capability) return Promise.reject(failure('COMPOSER_ATTACHMENT_UNSUPPORTED'));
  if (!input || typeof input !== 'object' || typeof input.uri !== 'string' ||
      typeof input.name !== 'string' || !input.uri || !input.name) {
    return Promise.reject(failure('COMPOSER_ATTACHMENT_INVALID'));
  }
  return app.request({
    method: 'cindy/composer-attachment/add',
    params: { uri: input.uri, name: input.name, requestId: globalThis.crypto?.randomUUID?.() },
  }, McpUiResourceTeardownResultSchema);
}

// A retained document can outlive its Main-side tickets. One listener per SDK
// module invalidates cached replies, including requests still in flight.
let dragEpoch = 0;
let boundElements = 0;
const invalidateTickets = event => {
  if (event.source === window.parent && event.data?.method === 'cindy/composer-attachment/tickets-invalidated') dragEpoch++;
};

/** Bind a granted resource to a native drag. Keep the button available for keyboard users. */
export function bindComposerAttachmentDrag(app, element, { uri, name }) {
  if (app?.getHostCapabilities?.()?.experimental?.[key]?.drag?.version !== 1) return () => {};
  const previous = element.getAttribute('draggable');
  const listeners = new AbortController();
  if (boundElements++ === 0) window.addEventListener('message', invalidateTickets);
  let pendingEpoch;
  let ticketEpoch;
  let ticket;
  let expires = 0;
  const prepare = async () => {
    const epoch = dragEpoch;
    if (pendingEpoch === epoch || (ticketEpoch === epoch && ticket && performance.now() < expires)) return;
    pendingEpoch = epoch;
    ticket = undefined;
    const started = performance.now();
    try {
      const result = await app.request({ method: 'cindy/composer-attachment/drag-ticket', params: { uri, name } },
        McpUiResourceTeardownResultSchema);
      if (!listeners.signal.aborted && dragEpoch === epoch && typeof result.ticket === 'string') {
        ticketEpoch = epoch;
        ticket = result.ticket;
        expires = started + 30_000;
      }
    } catch { /* The button stays available when drag preparation fails. */ }
    finally { if (pendingEpoch === epoch) pendingEpoch = undefined; }
  };
  element.draggable = true;
  if (element.matches(':hover')) void prepare();
  for (const event of ['pointerenter', 'pointerdown']) element.addEventListener(event, prepare, { signal: listeners.signal });
  element.addEventListener('dragstart', event => {
    event.stopPropagation();
    const data = event.dataTransfer;
    if (ticketEpoch !== dragEpoch || !ticket || performance.now() >= expires || !data) { event.preventDefault(); return; }
    data.items.clear();
    data.setData('application/x-cindy-composer-attachment-v1', ticket);
    data.effectAllowed = 'copy';
    ticket = undefined;
    if (data.types.length !== 1) event.preventDefault();
  }, { signal: listeners.signal });
  return () => {
    if (listeners.signal.aborted) return;
    listeners.abort();
    if (--boundElements === 0) window.removeEventListener('message', invalidateTickets);
    ticket = undefined;
    if (previous === null) element.removeAttribute('draggable');
    else element.setAttribute('draggable', previous);
  };
}
