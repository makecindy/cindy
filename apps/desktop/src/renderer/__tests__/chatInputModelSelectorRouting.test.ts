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
});
