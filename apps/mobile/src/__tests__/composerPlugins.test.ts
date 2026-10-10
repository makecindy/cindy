import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendComposerPluginTrigger, detectComposerPluginTrigger, filterComposerPlugins, placeComposerPlugin } from '@/session/composerPlugins';
import { textComposerDocument, composerDocumentProjectedText, serializeComposerDocument, type ComposerDocument } from '@/session/composerDocument';
import { expandGhostCommand, parseGhostCommandWord } from '@cindy/maker-shared/ghost-command';

const art = { manifest: { id: 'art', name: 'Art', command: 'art' }, enabled: true };
const old = { manifest: { id: 'old', name: 'Old', command: 'old' }, enabled: false };
const roster = [art, old];

describe('mobile composer plugin selection', () => {
  it('keeps every installed command reachable in the scrollable palette', () => {
    const plugins = Array.from({ length: 14 }, (_, index) => ({
      manifest: { id: `plugin-${index}`, name: `Plugin ${index}`, command: `plugin${index}` },
      enabled: true,
    }));
    expect(filterComposerPlugins(plugins, '')).toEqual(plugins);
    expect(filterComposerPlugins(plugins, 'plugin13')).toEqual([plugins[13]]);
  });
  it.each([['new', '\n'], ['new', '\r\n'], ['[sessionId]', '\n'], ['[sessionId]', '\r\n']])('places plugins inside the existing %s context sheet with %j line endings', (page, newline) => {
    const source = readFileSync(new URL('../../app/sessions/' + page + '.tsx', import.meta.url), 'utf8')
      .replace(/\r?\n/g, newline);
    const sheetStart = source.search(/<ContextSheet\s/);
    const sheetEnd = source.indexOf('</ContextSheet>', sheetStart);
    const plugins = source.indexOf('<ContextSheetPlugins');
    expect(sheetStart).toBeGreaterThan(0);
    expect(plugins).toBeGreaterThan(sheetStart);
    expect(plugins).toBeLessThan(sheetEnd);
  });
  it('prepends the plugin command and preserves the draft', () => {
    expect(composerDocumentProjectedText(placeComposerPlugin(textComposerDocument('draw a cat'), art, roster)))
      .toBe('$art draw a cat');
  });
  it.each(['draw a cat $ar', '$old draw a cat $ar', 'draw a cat ￥ar'])('routes a trailing selection in %s through the leading command', (text) => {
    const selected = composerDocumentProjectedText(placeComposerPlugin(textComposerDocument(text), art, roster));
    expect(selected).toBe('$art draw a cat ');
    expect(parseGhostCommandWord(selected)).toBe('art');
    expect(expandGhostCommand(selected, roster)).toContain('mcp__cindy__ghost_call');
    expect(detectComposerPluginTrigger(selected)).toBeNull();
  });
  it.each(['$OLD', '＄old', '￥old', '¥old'])('replaces installed disabled command %s', (command) => {
    expect(composerDocumentProjectedText(placeComposerPlugin(textComposerDocument(command + '\nkeep this'), art, roster)))
      .toBe('$art\nkeep this');
  });
  it('keeps unknown dollar text instead of treating it as a plugin', () => {
    expect(composerDocumentProjectedText(placeComposerPlugin(textComposerDocument('$100 budget'), art, roster)))
      .toBe('$art $100 budget');
  });
  it('keeps rich mentions, quotes and pasted text atoms intact', () => {
    const document: ComposerDocument = { version: 1, nodes: [
      { type: 'text', text: '$old ' },
      { type: 'mention', kind: 'file', label: 'README', raw: '@README.md' },
      { type: 'pasted-text', text: 'long body', display: 'Pasted Text' },
      { type: 'quote', quote: { text: 'quoted body' } },
    ] };
    const next = placeComposerPlugin(document, art, roster);
    expect(next.nodes.slice(1)).toEqual(document.nodes.slice(1));
    expect(next.nodes[0]).toEqual({ type: 'text', text: '$art ' });
  });
  it.each([
    ['draw a cat $ar', '$art ', 'draw a cat '],
    ['$old draw a cat $ar', '$art', ' draw a cat '],
  ])('places the command before a leading quote in %s', (text, command, body) => {
    const quote = { type: 'quote' as const, quote: { text: 'quoted body' } };
    const selected = placeComposerPlugin({ version: 1, nodes: [quote, { type: 'text', text }] }, art, roster);
    expect(selected.nodes).toEqual([
      { type: 'text', text: command }, quote, { type: 'text', text: body },
    ]);
    const wire = serializeComposerDocument(selected).text;
    expect(parseGhostCommandWord(wire)).toBe('art');
    expect(expandGhostCommand(wire, roster)).toContain('mcp__cindy__ghost_call');
  });
  it('preserves quotes around the replaced command and their order relative to the body', () => {
    const quotes: ComposerDocument['nodes'] = [
      { type: 'quote', quote: { text: 'first quote' } },
      { type: 'quote', quote: { text: 'second quote' } },
    ];
    const selected = placeComposerPlugin({ version: 1, nodes: [
      quotes[0], { type: 'text', text: '$old' }, quotes[1], { type: 'text', text: 'draw a cat $ar' },
    ] }, art, roster);
    expect(selected.nodes).toEqual([
      { type: 'text', text: '$art ' }, ...quotes, { type: 'text', text: 'draw a cat ' },
    ]);
    expect(parseGhostCommandWord(serializeComposerDocument(selected).text)).toBe('art');
  });
  it('does not select unavailable entries', () => {
    const document = textComposerDocument('keep this');
    expect(placeComposerPlugin(document, old, roster)).toBe(document);
    expect(placeComposerPlugin(document, { manifest: { id: 'panel', name: 'Panel' }, enabled: true }, roster)).toBe(document);
  });
  it('opens a live palette for a trailing dollar query', () => {
    expect(detectComposerPluginTrigger('$ar')).toEqual({ from: 0, query: 'ar' });
    expect(detectComposerPluginTrigger('draw $ar')).toEqual({ from: 5, query: 'ar' });
    expect(detectComposerPluginTrigger('draw $ar now')).toBeNull();
    expect(filterComposerPlugins([art, old], 'ar').map((plugin) => plugin.manifest.id)).toEqual(['art']);
    expect(composerDocumentProjectedText(placeComposerPlugin(textComposerDocument('$ar'), art, roster))).toBe('$art ');
  });
  it.each([['', '$'], ['draw a cat', 'draw a cat $'], ['draw a cat ', 'draw a cat $'], ['$ar', '$ar']])('opens the palette from draft %s without duplicating the query', (draft, expected) => {
    const opened = composerDocumentProjectedText(appendComposerPluginTrigger(textComposerDocument(draft)));
    expect(opened).toBe(expected);
    expect(detectComposerPluginTrigger(opened)).not.toBeNull();
  });
  it('closes the palette when its query is removed, sent or replaced by another trigger', () => {
    const opened = appendComposerPluginTrigger(textComposerDocument('draw a cat'));
    const selected = composerDocumentProjectedText(placeComposerPlugin(opened, art, roster));
    expect(detectComposerPluginTrigger(selected)).toBeNull();
    for (const draft of ['', 'draw a cat', '/help', '@README.md', 'draw $ar now']) {
      expect(detectComposerPluginTrigger(draft)).toBeNull();
    }
  });
  it('keeps rich atoms when opening and selecting from the trailing query', () => {
    const atoms: ComposerDocument['nodes'] = [
      { type: 'mention', kind: 'file', label: 'README', raw: '@README.md' },
      { type: 'pasted-text', text: 'long body', display: 'Pasted Text' },
      { type: 'quote', quote: { text: 'quoted body' } },
    ];
    const opened = appendComposerPluginTrigger({ version: 1, nodes: atoms });
    const selected = placeComposerPlugin(opened, art, roster);
    expect(selected.nodes.filter((node) => node.type !== 'text')).toEqual(atoms);
    expect(parseGhostCommandWord(composerDocumentProjectedText(selected))).toBe('art');
  });
  it('does not delete dollar queries embedded in pasted content', () => {
    const atom = { type: 'pasted-text' as const, text: 'example $ar', display: 'Pasted Text' };
    const selected = placeComposerPlugin({ version: 1, nodes: [atom] }, art, roster);
    expect(selected.nodes).toContainEqual(atom);
  });
});
