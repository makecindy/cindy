import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('mobile shared Cindy source card wiring', () => {
  it('renders provider and chat/topic name without treating hook input as a local user bubble', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain("item.message.kind === 'user' && item.message.hookSource");
    expect(source).toContain("kind: 'system' as const, align: 'agent' as const");
    expect(source).toContain('testID="message.hookSource"');
    expect(source).toContain("hookSource.im === 'telegram' ? 'Telegram' : 'Slack'");
    expect(source).toContain('{hookSource.channelName}');
    expect(source).toContain('(isUser || hookSource !== undefined)');
    expect(source).toContain("(item.message.kind === 'user' || hookSource !== undefined)");
  });
});
