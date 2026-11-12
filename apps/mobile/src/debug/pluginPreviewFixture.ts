import type { PluginNativeIntent } from '@cindy/device-link';

// Synthetic Host receipts; the card, modal, native resource server and WebView are real.
export const PREVIEW_FIXTURE_PLUGIN = 'qa-card-preview';
let intent: PluginNativeIntent | undefined;
let sequence = 0;
export function pluginPreviewFixture(channel: string, args: unknown[]): unknown {
  if (channel !== 'maker:remote-resources:invoke') return undefined;
  const request = args[0] as { resourceRef?: { id: string }; collectionId?: string; actionId?: string; input?: Record<string, unknown> };
  if (request.collectionId === 'plugin-results' && request.resourceRef?.id === JSON.stringify(['qa-preview', 'qa-preview-card'])) {
    if (!['editor', 'canvas'].includes(request.actionId ?? '')) throw new Error('UNKNOWN_QA_ACTION');
    intent = { id: String(++sequence), pluginId: PREVIEW_FIXTURE_PLUGIN, ghostName: 'Preview QA', kind: 'preview',
      url: `http://localhost:1234/${request.actionId}/index.html` };
    return { effects: [] };
  }
  if (request.resourceRef?.id !== PREVIEW_FIXTURE_PLUGIN) return undefined;
  switch (request.actionId) {
    case 'open-interaction': return { result: { pageId: 'qa-preview-page' } };
    case 'poll': return { result: { confirms: [], intents: intent ? [intent] : [] } };
    case 'intent:ack': case 'close': case 'suspend': intent = undefined; return { effects: [] };
    case 'preview:fetch': {
      if (!intent || intent.kind !== 'preview' || request.input?.intentId !== intent.id || request.input?.url !== intent.url) throw new Error('INVALID_QA_PREVIEW');
      const title = intent.url.includes('/editor/') ? 'Editor loaded' : 'Canvas loaded';
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark;color:CanvasText;background:Canvas}body{font:24px system-ui;padding:24px}button{font:inherit;padding:16px}</style></head><body><h1>${title}</h1><p>Native preview regression</p><button onclick="this.textContent='Interaction passed'">Test interaction</button></body></html>`;
      return { result: { status: 200, mime: 'text/html', revision: 'qa-1', base64: btoa(html) } };
    }
    default: throw new Error('UNKNOWN_QA_REQUEST');
  }
}
