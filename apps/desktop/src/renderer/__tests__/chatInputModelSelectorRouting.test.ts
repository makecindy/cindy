import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('ChatInput model source switching wiring', () => {
  it('lets a disconnected source reselect the highlighted fallback provider row', () => {
    const selectorStart = chatInputSource.lastIndexOf('<ModelSelector');
    expect(selectorStart).toBeGreaterThanOrEqual(0);

    const selectorEnd = chatInputSource.indexOf('/>', selectorStart);
    expect(selectorEnd).toBeGreaterThan(selectorStart);

    const selectorBlock = chatInputSource.slice(selectorStart, selectorEnd + 2);

    expect(selectorBlock).toContain('sourceDisconnected={selectedSourceDisconnected}');
    expect(selectorBlock).toContain('reselectEmitsChange={selectedSourceDisconnected}');
  });

  it('blocks DSH attachments and browser screenshots before building a send payload', () => {
    const dshGuard = chatInputSource.indexOf("currentModelAgentKind === 'dsh'");
    const filesToSend = chatInputSource.indexOf('const filesToSend =', dshGuard);

    expect(dshGuard).toBeGreaterThanOrEqual(0);
    expect(filesToSend).toBeGreaterThan(dshGuard);
    expect(chatInputSource.slice(dshGuard, filesToSend)).toContain(
      'attachmentsForSend.length > 0 || commentsForSend.length > 0',
    );
    expect(chatInputSource.slice(dshGuard, filesToSend)).toContain(
      "toast.warning(t('newChat.dshTextOnly'))",
    );
  });

  it('reads and writes DSH model/source preferences through the DSH draft slot', () => {
    expect(chatInputSource).toContain("getDraft().lastByVendor[vendorKey ?? 'cc']");

    const syncStart = chatInputSource.indexOf('const syncSessionDraftModelPrefs');
    const syncEnd = chatInputSource.indexOf('const persistFastModeChange', syncStart);
    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBlock = chatInputSource.slice(syncStart, syncEnd);
    expect(syncBlock).not.toContain("if (agentKind === 'dsh') return");
    expect(syncBlock).toContain('selectableVendorForAgentKind(agentKind)');
    expect(syncBlock).toContain('{ model: modelId, providerId: activeProviderId ?? null }');
  });
});
