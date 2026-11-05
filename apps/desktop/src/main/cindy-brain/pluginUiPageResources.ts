import fs from 'node:fs/promises';
import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { PLUGIN_UI_CAPABILITIES, pluginUiPointAcceptsScope } from '@cindy/maker-shared';
import { isSafeGhostRelativePath } from '../../shared/ghost.js';
import { MCP_APPS_MAX_BYTES } from '../mcp-apps/protocol.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { resolveGhostContentPath } from './ghostContentTree.js';
import { ghostFileMime } from './runtime/ghostFiles.js';

interface PageSource {
  ghost: { dir: string; ui: unknown };
  contributionId: string;
  /** Checks the actual instance, owner and view binding, not a page-supplied identity. */
  assertCurrent(): void;
}
type PageFile = { kind: 'entry' } | { kind: 'asset'; path: string };
const webAsset = /\.(?:js|mjs|css|json|txt|png|jpe?g|gif|webp|svg|ico|woff2?)$/i;

/** Read a single package file without giving the page filesystem access. */
export async function readPluginUiPageFile(source: PageSource, request: PageFile): Promise<{
  path: string; mimeType: string; bytes: Buffer;
}> {
  source.assertCurrent();
  const ui = parseGhostNativeUi(source.ghost.ui);
  const contribution = ui?.version === 1 && ui.contributions?.find(item => item.id === source.contributionId);
  if (!contribution || !PLUGIN_UI_CAPABILITIES.points.includes(contribution.point) ||
      !pluginUiPointAcceptsScope(contribution.point, contribution.scope) || !contribution.page)
    throw new Error('PAGE_UNAVAILABLE');
  const relative = request.kind === 'entry' ? contribution.page : request.path;
  if (!isSafeGhostRelativePath(relative) || (request.kind === 'asset' && !webAsset.test(relative)))
    throw new Error('PAGE_UNAVAILABLE');
  const before = await fs.lstat(source.ghost.dir, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !before.dev || !before.ino) throw new Error('PAGE_UNAVAILABLE');
  const root = await fs.realpath(source.ghost.dir);
  const file = await resolveGhostContentPath(source.ghost.dir, relative, { expect: 'file', label: 'plugin UI page' });
  const bytes = await readBoundedFileNoFollow(file, MCP_APPS_MAX_BYTES, { containWithin: root, nonBlocking: true, rejectHardLinks: true });
  await resolveGhostContentPath(source.ghost.dir, relative, { expect: 'file', label: 'plugin UI page' });
  const after = await fs.lstat(source.ghost.dir, { bigint: true });
  if (!bytes || !after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      await fs.realpath(source.ghost.dir) !== root) throw new Error('PAGE_UNAVAILABLE');
  source.assertCurrent();
  return { path: relative, mimeType: ghostFileMime(relative), bytes };
}
