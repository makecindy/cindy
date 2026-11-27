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

  it('allows native theme access while reporting theme switching and ignored RPC display methods', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', (_event, ctx) => {
            ctx.ui.notify(ctx.ui.theme.fg('accent', 'Ready'));
          });
        }
      `,
    });
    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'supported', compatibilityIssues: [], detectedApis: ['notify', 'theme'],
    });
    await fs.writeFile(pkg.entry, `
      export default function setup(pi: any) {
        pi.on('session_start', (_event, ctx) => {
          ctx.ui.setStatus('key', 'status');
          ctx.ui.setWidget('key', ['line']);
          ctx.ui.setTitle('title');
          ctx.ui.setEditorText('text');
          ctx.ui.pasteToEditor('text');
          ctx.ui.setTheme('light');
        });
      }
    `);
    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial',
      compatibilityIssues: ['editor-integration', 'status-display', 'terminal-title', 'theme-control', 'widgets'],
      detectedApis: ['pasteToEditor', 'setEditorText', 'setStatus', 'setTheme', 'setTitle', 'setWidget'],
    });
  });

  it('reports explicit timed dialogs in Settings but not TUI-only timers', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', async (_event, ctx) => {
            if (ctx.mode === 'tui') await ctx.ui.confirm('TUI', '', { timeout: 1000 });
            await ctx.ui.select('Choose', ['a']);
          });
        }
      `,
    });
    expect((await analyzePiExtensionCompatibility(pkg.entry, pkg.root)).compatibilityIssues).toEqual([]);
    await fs.writeFile(pkg.entry, `
      export default function setup(pi: any) {
        pi.on('session_start', async (_event, ctx) => {
          const confirm = ctx.ui.confirm;
          await confirm('Confirm', '', { timeout: 1000 });
        });
      }
    `);
    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial', compatibilityIssues: ['interactive-dialogs'], detectedApis: ['confirm'],
    });
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

  // 测试价值：生产入口 analyzePiExtensionCompatibility；用户看到 bundled 扩展是否仍被标 unknown。
  // Bug 依据：context-mode 2.2.3 的 pi/index.js 为 2.27 MB，旧 512 KiB 上限直接放弃分析。
  // 现有覆盖缺口：现有用例只覆盖小源码和语法错误，没有覆盖单文件达到真实包体积的情况。
  // 最小失败输入：一个 3 MiB 注释 + 可解析 API 调用的扩展入口。tier：unit。
  it('inspects bundled extensions up to the raised byte budget', async () => {
    const pkg = await makePackage({
      'index.ts': `
        export default function setup(pi: any) {
          pi.on('session_start', (_event, ctx: any) => ctx.ui.setStatus('key', 'ready'));
        }
        /* ${'x'.repeat(3 * 1024 * 1024)} */
      `,
    });

    await expect(analyzePiExtensionCompatibility(pkg.entry, pkg.root)).resolves.toMatchObject({
      compatibility: 'partial',
      compatibilityIssues: ['status-display'],
      detectedApis: ['setStatus'],
      scannedFiles: 1,
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
