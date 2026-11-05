import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_APPS_MAX_BYTES } from '../../mcp-apps/protocol.js';
import { readPluginUiPageFile } from '../pluginUiPageResources.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-page-'));
  roots.push(dir);
  await fs.mkdir(path.join(dir, 'ui'));
  await fs.writeFile(path.join(dir, 'ui/view.html'), '<script src="view.js"></script>');
  await fs.writeFile(path.join(dir, 'ui/view.js'), 'document.body.textContent = "ok"');
  const ghost = { dir, ui: { version: 1, contributions: [{ id: 'view', point: 'message.body', scope: 'message', page: 'ui/view.html' }] } };
  return { ghost, contributionId: 'view', assertCurrent: () => {} };
}

describe('plugin UI page files', () => {
  it('reads only the declared page and bounded local web assets', async () => {
    const f = await fixture();
    const page = await readPluginUiPageFile(f, { kind: 'entry' });
    expect(page).toMatchObject({ path: 'ui/view.html', mimeType: 'text/html; charset=utf-8' });
    expect(page.bytes.toString()).toContain('view.js');
    const script = await readPluginUiPageFile(f, { kind: 'asset', path: 'ui/view.js' });
    expect(script.mimeType).toBe('text/javascript; charset=utf-8');
    await expect(readPluginUiPageFile({ ...f, contributionId: 'other' }, { kind: 'entry' })).rejects.toThrow();
    for (const candidate of ['../outside.js', 'https://example.com/x.js', 'ui/view.html', 'secret.key']) {
      await expect(readPluginUiPageFile(f, { kind: 'asset', path: candidate })).rejects.toThrow();
    }
  });
  it('rejects linked files, linked directories and oversized assets', async () => {
    const f = await fixture();
    await fs.symlink('view.js', path.join(f.ghost.dir, 'ui/link.js'));
    await fs.symlink('ui', path.join(f.ghost.dir, 'alias'));
    await fs.link(path.join(f.ghost.dir, 'ui/view.js'), path.join(f.ghost.dir, 'ui/hard.js'));
    await fs.writeFile(path.join(f.ghost.dir, 'ui/large.js'), Buffer.alloc(MCP_APPS_MAX_BYTES + 1));
    for (const candidate of ['ui/link.js', 'alias/view.js', 'ui/hard.js', 'ui/large.js']) {
      await expect(readPluginUiPageFile(f, { kind: 'asset', path: candidate })).rejects.toThrow();
    }
  });
  it('checks that the original instance and view are still current after reading', async () => {
    const f = await fixture(); let checks = 0;
    f.assertCurrent = () => { if (++checks > 1) throw new Error('CONTEXT_CHANGED'); };
    await expect(readPluginUiPageFile(f, { kind: 'entry' })).rejects.toThrow('CONTEXT_CHANGED');
  });
});
