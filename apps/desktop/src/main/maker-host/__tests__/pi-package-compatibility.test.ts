import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzePiExtensionCompatibility } from '../pi-package-compatibility.js';

const roots: string[] = [];

async function makePackage(
  files: Record<string, string>,
): Promise<{ root: string; entry: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-compat-'));
  roots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source, 'utf8');
  }
  return { root, entry: path.join(root, 'index.ts') };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Pi extension compatibility parser', () => {
  it('follows local imports and reports the exact unsupported Pi UI APIs', async () => {
    const pkg = await makePackage({
      'index.ts': `
        import { openPicker } from './picker.js';
        export default function setup(pi: unknown) { return openPicker; }
      `,
      'picker.ts': `
        type ExtensionCommandContext = { ui: unknown };
        export async function openPicker(_args: string, sessionContext: ExtensionCommandContext) {
          const { ui } = sessionContext;
          const choose = ui.select;
          await choose('Pick', ['one']);
          ui.setStatus('sample', 'ready');
        }
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial',
      compatibilityIssues: ['status-display'],
      detectedApis: ['select', 'setStatus'],
      scannedFiles: 2,
    });
  });

  it('does not warn for TUI-only calls or RPC UI requests that Cindy adapts', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', async (_event: unknown, runtime) => {
            if (runtime.mode === 'tui') await runtime.ui.custom(() => undefined);
            await runtime.ui.select('Pick', ['a', 'b']);
            await runtime.ui.confirm('Confirm', 'Proceed?');
            await runtime.ui.input('Name');
            await runtime.ui.editor('Edit', 'draft');
            runtime.ui.notify('loaded');
          });
        }
      `,
    });

    const result = await analyzePiExtensionCompatibility(pkg.entry, pkg.root);
    expect(result.compatibility).toBe('supported');
    expect(result.detectedApis).toEqual(['confirm', 'editor', 'input', 'notify', 'select']);
    expect(result.compatibilityIssues).toEqual([]);
  });

  it('ignores comments and string literals that only mention Pi UI APIs', async () => {
    const pkg = await makePackage({
      'index.ts': `
        // ctx.ui.select('not a call', [])
        const example = "ctx.ui.setWidget('not a call', [])";
        export default function setup() { return example; }
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'supported',
      compatibilityIssues: [],
      detectedApis: [],
    });
  });

  it('detects custom editor component APIs used by TUI-dependent packages', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', (_event: unknown, ctx: any) => {
            const current = ctx.ui.getEditorComponent();
            ctx.ui.setEditorComponent(current);
          });
        }
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial',
      compatibilityIssues: ['editor-integration'],
      detectedApis: ['getEditorComponent', 'setEditorComponent'],
    });
  });

  it('detects Pi 0.83 UI properties and methods that cannot be presented in Cindy RPC', async () => {
    const pkg = await makePackage({
      'index.ts': `
        import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
        export default function setup(extensionApi: ExtensionAPI) {
          const { registerFlag, registerMessageRenderer } = extensionApi;
          registerFlag('sample', { type: 'boolean' });
          registerMessageRenderer('sample', () => undefined);
          extensionApi.registerShortcut('ctrl+x', { handler() {} });
          extensionApi.registerMarkdownTransformer(() => undefined);
          extensionApi.registerEntryRenderer('sample', () => undefined);
          extensionApi.on('session_start', (_event: unknown, ctx: ExtensionContext) => {
            const { setWorkingVisible, setHiddenThinkingLabel, addAutocompleteProvider } = ctx.ui;
            setWorkingVisible(false);
            setHiddenThinkingLabel('hidden');
            addAutocompleteProvider({});
            ctx.ui.onTerminalInput(() => undefined);
            return ctx.ui.theme;
          });
        }
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial',
      compatibilityIssues: [
        'cli-flags',
        'editor-integration',
        'status-display',
        'terminal-input',
        'theme-control',
        'tui-rendering',
      ],
      detectedApis: [
        'addAutocompleteProvider',
        'onTerminalInput',
        'registerEntryRenderer',
        'registerFlag',
        'registerMarkdownTransformer',
        'registerMessageRenderer',
        'registerShortcut',
        'setHiddenThinkingLabel',
        'setWorkingVisible',
        'theme',
      ],
    });
  });

  it('does not warn for extension UI APIs reachable only in an explicit TUI branch', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', (_event: unknown, ctx: any) => {
            if (ctx.mode === 'tui') {
              ctx.ui.onTerminalInput(() => undefined);
              void ctx.ui.theme;
            }
          });
        }
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'supported',
      compatibilityIssues: [],
      detectedApis: [],
    });
  });

  it('reports an incomplete analysis instead of claiming compatibility after a parse failure', async () => {
    const pkg = await makePackage({ 'index.ts': 'export default function broken( {' });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'unknown',
      compatibilityIssues: ['analysis-incomplete'],
    });
  });
});
