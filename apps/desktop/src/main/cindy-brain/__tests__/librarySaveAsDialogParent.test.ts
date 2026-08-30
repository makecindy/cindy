import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('library saveAs dialog parent wiring', () => {
  const mainSource = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const start = mainSource.indexOf('export function getGhostLibrarySlot(');
  const end = mainSource.indexOf('\n}\n\n/**\n * 迁移执行体', start);
  const body = mainSource.slice(start, end);

  it('parents saveAs to a visible main-shell window, not getAllWindows()[0]', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('const candidates = mainShellWindows();');
    expect(body).toContain('candidates.includes(focused)');
    expect(body).toContain("throw new Error('没有可挂靠的宿主窗口')");
    expect(body).not.toContain('BrowserWindow.getAllWindows()[0]');
  });
});
