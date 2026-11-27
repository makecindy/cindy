import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PRELOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The shared renderer entry subscribes to localThemes.onChanged in every window, so a window
// preload that exposes listSync without onChanged fails to load its page (e.g. the cloud login window).
function localThemesBlocks(): Array<{ file: string; block: string }> {
  return fs.readdirSync(PRELOAD_DIR)
    .filter(file => file.endsWith('.ts'))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(PRELOAD_DIR, file), 'utf8');
      const match = /^([ \t]*)localThemes: \{$/m.exec(source);
      if (!match) return [];
      const end = source.indexOf(`\n${match[1]}},`, match.index);
      return [{ file, block: source.slice(match.index, end) }];
    });
}

describe('localThemes preload parity', () => {
  it('finds every window preload that exposes local themes', () => {
    expect(localThemesBlocks().map(item => item.file)).toEqual(expect.arrayContaining([
      'cloudLoginWindowPreload.ts', 'preload.ts', 'remoteDesktopViewerPreload.ts', 'resourceUsagePreload.ts',
      'screenshotPageBridge.ts', 'sidebarWindowPreload.ts',
    ]));
  });

  it.each(localThemesBlocks())('$file exposes listSync and onChanged', ({ block }) => {
    expect(block).toContain('listSync:');
    expect(block).toContain('onChanged:');
  });
});
