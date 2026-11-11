import { expect, it } from 'vitest';
import { botSettingsRef, parseRemoteBotSettings } from '../remoteBotSettingsData';

const field = { id: 'name', label: 'Name', kind: 'text' };
const action = { id: 'grant', label: 'Save', fields: [field] };
function resource() {
  return {
    ref: botSettingsRef('bot'),
    revision: '1',
    display: { title: 'Cindy' },
    links: [],
    actions: [action],
    blocks: [
      {
        id: 'profile',
        title: 'Profile',
        primitive: 'form',
        fallbackMarkdown: 'Read only',
        data: { actionId: 'grant', values: { name: 'Cindy' } },
      },
    ],
  };
}
it('retains complete supported forms with translated confirmation text', () => {
  const confirmation = {
    title: { fallback: 'Save?', translations: { zh: '保存？' } },
    body: 'Confirm changes',
    confirmLabel: 'Save',
  };
  const parsed = parseRemoteBotSettings(
    { ...resource(), actions: [{ ...action, confirmation }] },
    botSettingsRef('bot'),
  );
  expect(parsed.panels[0].action?.confirmation).toEqual(confirmation);
  expect(parsed.panels[0].values).toEqual({ name: 'Cindy' });
});
it.each([
  { confirmation: { title: 'Confirm', body: 42 } },
  {
    confirmation: { title: 'Confirm', confirmLabel: { fallback: 'Yes', translations: { en: 1 } } },
  },
  { confirmation: null },
  { disabled: 'false' },
  { id: 'x'.repeat(513) },
  { label: 'x'.repeat(20_001) },
  { fields: Array.from({ length: 65 }, (_, i) => ({ ...field, id: `field${i}` })) },
  { fields: [field, field] },
  { fields: [{ ...field, kind: ['text'] }] },
  {
    fields: [
      {
        ...field,
        kind: 'select',
        options: Array.from({ length: 1001 }, () => ({ value: 'a', label: 'A' })),
      },
    ],
  },
  { fields: [{ ...field, placeholder: { fallback: 'Name', translations: [] } }] },
])('makes malformed actions read-only instead of executing partial forms: %#', (patch) => {
  const parsed = parseRemoteBotSettings(
    { ...resource(), actions: [{ ...action, ...patch }] },
    botSettingsRef('bot'),
  );
  expect(parsed.panels[0].action).toBeUndefined();
  expect(parsed.panels[0].text).toBe('Read only');
});
it('never saves a clipped form value', () => {
  const raw = resource();
  raw.blocks[0].data.values.name = 'x'.repeat(65_537);
  expect(parseRemoteBotSettings(raw, raw.ref).panels[0].action).toBeUndefined();
});
it('bounds action and block counts without leaving ambiguous action IDs executable', () => {
  const raw = resource();
  expect(
    parseRemoteBotSettings({ ...raw, actions: [action, action] }, raw.ref).panels[0].action,
  ).toBeUndefined();
  expect(
    parseRemoteBotSettings({ ...raw, actions: Array(257).fill(action) }, raw.ref).panels[0].action,
  ).toBeUndefined();
  expect(
    parseRemoteBotSettings({ ...raw, blocks: Array(257).fill(raw.blocks[0]) }, raw.ref).panels,
  ).toHaveLength(256);
});
it('rejects oversized aggregate, deeply nested and excessively numerous host data before interpretation', () => {
  const raw = resource();
  for (const extra of [
    'x'.repeat(2_000_001),
    Array(2001).fill(null),
    Array.from({ length: 1000 }, () => Array(21).fill(true)),
    Array.from({ length: 14 }).reduce<unknown>((value) => ({ value }), null),
  ])
    expect(() => parseRemoteBotSettings({ ...raw, extra }, raw.ref)).toThrow(
      'Invalid teammate settings',
    );
});
it('filters malformed list identities and titles', () => {
  const raw = resource();
  const parsed = parseRemoteBotSettings(
    {
      ...raw,
      blocks: [
        {
          ...raw.blocks[0],
          data: {
            entries: [
              { id: 'valid', title: 'Skill', resourceId: 'bot/skills/valid' },
              { id: 'oversized', title: 'Skill', resourceId: 'x'.repeat(257) },
              {
                id: 'bad-title',
                title: { fallback: 'Skill', translations: { en: false } },
                resourceId: 'bot/skills/bad',
              },
            ],
          },
        },
      ],
    },
    raw.ref,
  );
  expect(parsed.panels[0].entries).toEqual([
    { id: 'valid', title: 'Skill', resourceId: 'bot/skills/valid' },
  ]);
});

it('retains bounded host avatar metadata and drops malformed avatar descriptions', () => {
  const raw = resource();
  const avatar = {
    kind: 'media',
    value: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    fallbackText: 'C',
    color: 'blue',
  };
  const parse = (value: unknown) =>
    parseRemoteBotSettings({ ...raw, display: { ...raw.display, avatar: value } }, raw.ref).resource
      .display.avatar;
  expect(parse(avatar)).toEqual(avatar);
  for (const value of [
    null,
    { ...avatar, kind: 1 },
    { ...avatar, value: 'x'.repeat(4097) },
    { ...avatar, fallbackText: 'x'.repeat(65) },
  ]) {
    expect(parse(value)).toBeUndefined();
  }
});
