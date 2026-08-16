import { describe, expect, it } from 'vitest';

import { BOT_TEMPLATES, getBotTemplate } from '../botTemplates';

describe('Bot product templates', () => {
  it('keeps Hermes-style identity separate from structured capabilities', () => {
    expect(BOT_TEMPLATES.map((template) => template.id)).toEqual([
      'control',
      'pr-steward',
      'assistant',
    ]);
    for (const template of BOT_TEMPLATES) {
      expect(template.identitySource.trim()).not.toBe('');
      expect(template.identitySource).not.toMatch(
        /Telegram token|MCP server|workingDir|userContext/i,
      );
      expect(template.capabilities.permissions).toBe('ask');
    }
  });

  it('makes control templates event-aware without granting that power to a normal assistant', () => {
    expect(getBotTemplate('control')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('pr-steward')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('assistant')).toMatchObject({
      autoSubscribeToTaskEvents: false,
      capabilities: { automation: false, sessionControlMode: 'none' },
    });
  });
});
