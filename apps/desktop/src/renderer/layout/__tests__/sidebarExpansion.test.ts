/** Unit geometry regression for outward sidebar expansion: preserve chat width with
 * proportional or saved pixel widths. Existing layout tests did not solve native growth;
 * an 800px equal split or an additional docked pane exposes the missing divider/ratio delta.
 */
import { describe, expect, it } from 'vitest';
import { sidebarExpansionWidth } from '../sidebarExpansion';

describe('sidebar expansion geometry', () => {
  it('keeps the chat width with an equal split', () => {
    expect(sidebarExpansionWidth(800, [{ share: 0.5, min: 120, sidebar: true }])).toBe(802);
  });
  it('accounts for other panels growing with the window', () => {
    const growth = sidebarExpansionWidth(1000, [
      { share: 0.2, min: 120, sidebar: false },
      { share: 0.3, min: 120, sidebar: true },
    ]);
    expect(growth).toBe(602);
    expect((1000 + growth) * 0.5 - 2).toBe(799);
  });
  it('uses the panel floor instead of overexpanding a narrow sidebar', () => {
    expect(sidebarExpansionWidth(800, [{ share: 0.1, min: 120, sidebar: true }])).toBe(121);
  });
  it('restores a saved pixel width while accounting for other docked panels', () => {
    expect(sidebarExpansionWidth(1000, [
      { share: 0.2, min: 120, sidebar: false },
      { share: 0.3, min: 120, sidebar: true, preferredWidth: 399 },
    ])).toBe(500);
  });
});
