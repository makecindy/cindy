import assert from 'node:assert/strict';

// PR #10971: the file tree colours names by git status and marks directories with a
// rolled-up dot. Unit tests prove the map building; they cannot prove the tree paints
// the semantic tokens or that the marker survives the themed row backgrounds, and the
// status marker's accessible name is a translation rather than a raw key.
// Minimum failures: an uncoloured name, a marker missing its letter, a raw
// `ccAgent.workdirBrowse.gitStatus.*` key, and a missing directory dot.
// Tier: opt-in UI integration over fixture host data; no filesystem or git activity.
const CASES = [
  ['README.md', 'M', '--warning-fg'],
  ['new-file.ts', 'A', '--diff-add-fg'],
  ['gone.ts', 'D', '--diff-del-fg'],
  ['renamed.ts', 'R', '--text-secondary'],
  ['draft.txt', 'U', '--focus-ring'],
  ['conflict.ts', '!', '--diff-del-fg'],
];

export default {
  name: 'workdir-git-tree',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 440 },
  real: 'FileTreeView, useFileTree and useWorkdirGitChanges over fixture git-review data',
  notCovered:
    'Real Git, IPC transport and file watching; covered by unit and Git integration tests',
  cases: {
    default: { about: 'Six file states and one rolled-up directory state in the sidebar tree' },
    narrow: {
      about: 'The status marker and directory dot survive at 320 px',
      viewport: { width: 320, height: 300 },
    },
  },
  async check(page, ui) {
    await page.locator('[data-relpath="conflict.ts"]').waitFor();
    const observed = await page.evaluate((rows) => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const read = rows.map(([relPath, , token]) => {
        const row = document.querySelector(`[data-relpath="${relPath}"]`);
        const marker =
          row instanceof HTMLElement
            ? [...row.querySelectorAll('span')].find((el) => el.getAttribute('title'))
            : undefined;
        probe.style.color = `var(${token})`;
        return {
          relPath,
          code: marker?.textContent ?? null,
          label: marker?.getAttribute('aria-label') ?? null,
          color: marker ? getComputedStyle(marker).color : null,
          expected: getComputedStyle(probe).color,
        };
      });
      const folderRow = document.querySelector('[data-relpath="src"]');
      const dot =
        folderRow instanceof HTMLElement
          ? [...folderRow.querySelectorAll('span')].find((el) => el.getAttribute('aria-label'))
          : undefined;
      probe.style.backgroundColor = 'var(--warning-fg)';
      const directory = {
        label: dot?.getAttribute('aria-label') ?? null,
        background: dot ? getComputedStyle(dot).backgroundColor : null,
        expected: getComputedStyle(probe).backgroundColor,
      };
      probe.remove();
      return { files: read, directory, codes: rows.map(([relPath, code]) => [relPath, code]) };
    }, CASES);

    for (const [index, entry] of observed.files.entries()) {
      const [, code] = observed.codes[index];
      assert.equal(entry.code, code, `${entry.relPath} needs its status letter`);
      assert.equal(
        entry.color,
        entry.expected,
        `${entry.relPath} must paint the registered status colour`,
      );
      assert.ok(entry.label && !entry.label.startsWith('ccAgent.'), 'Status needs a translation');
    }
    assert.equal(observed.directory.background, observed.directory.expected, 'Directory dot colour');
    assert.ok(
      observed.directory.label && !observed.directory.label.startsWith('ccAgent.'),
      'Directory dot needs a translation',
    );
    await ui.capture('verified');
  },
};
