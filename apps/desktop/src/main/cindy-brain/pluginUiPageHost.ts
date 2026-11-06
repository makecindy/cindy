import type { PluginUiService } from './pluginUiService.js';
import { createPluginUiPageBridge } from './pluginUiPageBridge.js';
import type { readPluginUiPageFile } from './pluginUiPageResources.js';

type BoundPage = Awaited<ReturnType<PluginUiService['bindPage']>>;
type PageFileReader = typeof readPluginUiPageFile;
interface Dependencies {
  bind(controller: string, sessionId: string, viewId: string, revision: string, current: () => boolean): Promise<BoundPage>;
  instance(id: string): { dir: string; ui: unknown } | null;
  readFile: PageFileReader;
  appearance(id: string, input: unknown, assertCurrent: () => void): Promise<unknown>;
  visibility(id: string, input: unknown, windowId: number, assertCurrent: () => void): Promise<unknown>;
  mount(input: { html: string; entry: string }, caller: string, invoke: (input: unknown) => Promise<unknown>,
    readAsset: (relativePath: string) => Promise<Response>, dispose: () => void): string;
  unmount(id: string, caller: string): void;
}

/** Owns only ephemeral page mounts; the original view remains the authority. */
export class PluginUiPageHost {
  private pages = new Map<string, { controller: string; caller: string; viewId: string }>();
  constructor(private readonly deps: Dependencies) {}

  async open(controller: string, sessionId: string, viewId: string, revision: string, current: () => boolean): Promise<string> {
    if (!/^local:\d+$/.test(controller)) throw new Error('UI_UNAVAILABLE');
    const page = await this.deps.bind(controller, sessionId, viewId, revision, current);
    const ghost = this.deps.instance(page.instanceId);
    if (!ghost) throw new Error('UI_UNAVAILABLE');
    const assertCurrent = () => { if (!current() || !page.current()) throw new Error('CONTEXT_CHANGED'); };
    const source = { ghost, contributionId: page.contributionId, assertCurrent };
    const entry = await this.deps.readFile(source, { kind: 'entry' });
    await page.assertCurrent(); assertCurrent();
    const html = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    const bridge = createPluginUiPageBridge({
      current: () => current() && page.current(), read: page.read, capabilities: page.capabilities, invoke: page.invoke,
      visibility: async input => {
        await page.assertCurrent(); assertCurrent();
        const result = await this.deps.visibility(page.instanceId, input, Number(controller.slice('local:'.length)), assertCurrent);
        await page.assertCurrent(); assertCurrent();
        return result;
      },
      appearance: async input => {
        await page.assertCurrent(); assertCurrent();
        const result = await this.deps.appearance(page.instanceId, input, assertCurrent);
        await page.assertCurrent(); assertCurrent();
        return result;
      },
    }, { readOnly: page.readOnly });
    const readAsset = async (relativePath: string) => {
      await page.assertCurrent(); assertCurrent();
      const file = await this.deps.readFile(source, { kind: 'asset', path: relativePath });
      await page.assertCurrent(); assertCurrent();
      return new Response(new Uint8Array(file.bytes), { headers: { 'Content-Type': file.mimeType,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    };
    const caller = `renderer:${controller.slice('local:'.length)}`;
    let id = '';
    const dispose = () => { bridge.dispose(); if (id) this.pages.delete(id); };
    id = this.deps.mount({ html, entry: entry.path }, caller, bridge.handle, readAsset, dispose);
    this.pages.set(id, { controller, caller, viewId });
    try { await page.assertCurrent(); assertCurrent(); }
    catch (error) { this.deps.unmount(id, caller); throw error; }
    return id;
  }

  async close(controller: string, id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page || page.controller !== controller) throw new Error('UI_UNAVAILABLE');
    this.deps.unmount(id, page.caller);
  }

  releaseBinding(viewId: string): void {
    for (const [id, page] of this.pages) if (page.viewId === viewId) this.deps.unmount(id, page.caller);
  }
}
