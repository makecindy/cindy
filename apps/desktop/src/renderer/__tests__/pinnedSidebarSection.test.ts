/**
 * pinnedSidebarSection — pinned section sidebar invariants.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const pinnedSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'PinnedSection.tsx'),
  'utf8',
);

describe('Pinned sidebar section', () => {
  it('uses the same title color tokens as Projects and Dialogue in light and dark themes', () => {
    const titleIndex = pinnedSectionSource.indexOf("t('ccAgent.sidebar.pinned')");
    const titleButtonIndex = pinnedSectionSource.lastIndexOf('<button', titleIndex);
    const titleButtonBlock = pinnedSectionSource.slice(titleButtonIndex, titleIndex);

    expect(titleButtonBlock).toContain('text-[var(--sidebar-list-muted)]');
    expect(titleButtonBlock).toContain('hover:text-[var(--sidebar-nav-text)]');
    expect(titleButtonBlock).not.toContain('text-[var(--text-tertiary)]');
    expect(titleButtonBlock).not.toContain('hover:text-[var(--text-secondary)]');
  });

  it('passes source labels to pinned list cards as well as text rows', () => {
    expect(pinnedSectionSource).toContain('sourceLabel={sourceLabelMap.get(session.id)}');
    expect(pinnedSectionSource).toContain('sourceLabel={sourceLabelMap.get(entry.session.id)}');
  });
});
