import { describe, expect, it } from 'vitest';
import { windowStateElements } from '../windowStateElements.js';

// Rows copied from a real cua-driver 0.37.0 read of the smoke fixture window.
const REAL_MARKDOWN = [
  '- [0] AXWindow "Cindy Computer Use Smoke" [actions=[raise]]',
  '  - [1] AXWebArea "Cindy Computer Use Smoke"',
  '    - [4] AXStaticText = "Smoke message"',
  '    - [5] AXTextArea (Smoke message) [actions=[press]]',
  '    - [6] AXButton "Increment smoke count" [actions=[press]]',
  '  - [8] AXButton [actions=[press]]',
].join('\n');

describe('windowStateElements', () => {
  it('addresses the fixture controls by <snapshot_id>:row, as the model reads them', () => {
    const elements = windowStateElements({ snapshot_id: 's00000036', tree_markdown: REAL_MARKDOWN });
    expect(elements.find((e) => e.role === 'AXTextArea' && e.label === 'Smoke message')).toEqual({
      element_token: 's00000036:5',
      role: 'AXTextArea',
      label: 'Smoke message',
    });
    expect(elements.find((e) => e.role === 'AXButton' && e.label === 'Increment smoke count')?.element_token).toBe(
      's00000036:6',
    );
    expect(elements.find((e) => e.element_token === 's00000036:8')).toMatchObject({ role: 'AXButton', label: undefined });
  });

  it('falls back to elements when the Markdown tree is empty or absent', () => {
    const listed = [{ element_token: 'a:1', role: 'AXButton', label: 'OK' }];
    expect(windowStateElements({ snapshot_id: 's1', tree_markdown: '', elements: listed })).toEqual(listed);
    expect(windowStateElements({ elements: listed })).toEqual(listed);
    expect(windowStateElements(undefined)).toEqual([]);
  });
});
