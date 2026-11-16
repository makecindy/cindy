/**
 * Manual e2e regression for #9695. jsdom cannot reproduce browser default wheel
 * scrolling. Run the actual new-task page through the public MCP dispatcher,
 * production host guards and installed native driver, inside an opt-in UI mock.
 * Minimum failure: one wheel over a project row must move once, without a
 * passive-listener error. DOM access only sets fixture state and observes it;
 * every click, key and wheel goes through the ordinary Computer Use entry.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from '@cindy/mcps/computer';
import { cleanupComputerDriverSession, getComputerMcpDeps } from '../mcp-integrations/computer.desktop.js';

export async function runFolderPickerWheelSmoke(window: BrowserWindow): Promise<void> {
  if (app.isPackaged || process.env.XDT_ISOLATED !== '1' || process.env.XDT_UI_MOCK !== '1') return;
  const root = path.join(app.getPath('userData'), 'folder-picker-wheel-smoke');
  const sessionId = `folder-wheel-smoke-${randomUUID()}`;
  const checks: unknown[] = [];
  const actions: unknown[] = [];
  const errors: string[] = [];
  const report: Record<string, unknown> = {
    ok: false,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    checks,
    actions,
    errors,
  };
  let client: Client | undefined;
  let server: ReturnType<typeof createComputerMcpServer> | undefined;
  let step = 'setup';
  const read = (script: string) => window.webContents.executeJavaScript(script);
  // real-wait: manual native-driver e2e needs browser painting and smooth-scroll completion.
  const settle = (ms = 500) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const consoleListener = (details: { message: string }) => {
    if (/passive event listener|Unable to preventDefault/i.test(details.message))
      errors.push(details.message);
  };
  window.webContents.on('console-message', consoleListener);
  try {
    await fs.mkdir(root, { recursive: true });
    app.setAccessibilitySupportEnabled(true);
    window.setSize(1280, 1000);
    window.show();
    server = createComputerMcpServer(getComputerMcpDeps({ isComputerUseEnabled: () => true }), {
      sessionId,
      getSessionContext: () => ({ sessionId, agentKind: 'computer-smoke', workingDir: root }),
    });
    client = new Client({ name: 'folder-picker-wheel-smoke', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool(
        { name: 'call_tool', arguments: { name, args } },
        undefined,
        { timeout: 60_000 },
      );
      const text = (result.content as Array<{ text?: string }>).find((c) => c.text)?.text;
      const payload = JSON.parse(text ?? '{}');
      if (!payload.ok) throw new Error(`${name}: ${JSON.stringify(payload)}`);
      return payload;
    };
    const until = async (script: string) => {
      for (let i = 0; i < 300; i++) {
        if (await read(script)) return;
        await settle(200);
      }
      throw new Error(`UI did not become ready: ${script}`);
    };
    // Restored task/companion pages do not have the new-task project picker.
    // Wait for its controls only after using the shared navigation below.
    await until(`!!window.electronAPI`);
    // DOM coordinates below assume CSS pixels and window DIPs have the same scale.
    window.webContents.setZoomFactor(1);
    await settle();
    report.zoomFactor = window.webContents.getZoomFactor();
    const windows = await call('list_windows', {
      pid: process.pid,
      session_goal: 'Verify folder picker wheel input',
    });
    const handle = window.getNativeWindowHandle();
    const ownId = process.platform === 'win32' ? handle.readUInt32LE() : undefined;
    const target = windows.data?.windows?.find((w: { window_id: number }) => w.window_id === ownId);
    assert(
      target,
      'Own main window was not discovered (this manual smoke currently requires Windows)',
    );
    const targetArgs = { pid: process.pid, window_id: target.window_id };
    report.target = targetArgs;
    const observe = () =>
      call('get_window_state', {
        ...targetArgs,
        include_screenshot: true,
        screenshot_out_file: path.join(root, 'latest.png'),
      });
    const point = async (selector: string) => {
      assert(
        window.webContents.getZoomFactor() === 1,
        'Folder picker wheel smoke requires 100% page zoom; refusing coordinate input',
      );
      const p = await read(
        `(()=>{const e=${selector};if(!e)return null;const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,visible:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,text:e.textContent?.slice(0,100)}})()`,
      );
      assert(p?.visible, `Target missing or outside viewport: ${selector}; ${JSON.stringify(p)}`);
      const b = window.getBounds(),
        c = window.getContentBounds();
      return { x: p.x + c.x - b.x, y: p.y + c.y - b.y, clientX: p.x, clientY: p.y };
    };
    const click = async (selector: string) => {
      await observe();
      const p = await point(selector);
      await read(
        `window.__smokeClick=null;document.addEventListener('click',e=>{window.__smokeClick={x:e.clientX,y:e.clientY,trusted:e.isTrusted,text:e.target.closest('button')?.textContent}},{once:true,capture:true})`,
      );
      const receipt = await call('click', {
        ...targetArgs,
        x: p.x,
        y: p.y,
        delivery_mode: 'foreground',
      });
      await settle();
      actions.push({ selector, point: p, receipt, actual: await read('window.__smokeClick') });
      await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    };
    const key = async (key: string) => {
      await call('press_key', { ...targetArgs, key, delivery_mode: 'foreground' });
      await settle();
    };
    const buttons = `[...document.querySelectorAll('button')]`;
    const dismissCrashNotice = async () => {
      const dismiss = `${buttons}.find(e=>/^(暂不处理|Not now)$/.test(e.textContent.trim()))`;
      if (await read(`!!(${dismiss})`)) await click(dismiss);
    };
    // Use the visible New Task navigation, not a replacement component page.
    step = 'new-task';
    await settle(3500);
    await dismissCrashNotice();
    await until(
      `${buttons}.some(e=>/新建任务|New task/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent))`,
    );
    await click(
      `${buttons}.find(e=>/新建任务|New task/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent))`,
    );
    const trigger = `document.querySelector('[data-testid="create-agent-mode-pill"]')`;
    await until(`location.hash.includes('/new') && !!${trigger}`);
    const list = `document.querySelector('[data-folder-picker-scroll]')`;
    const popup = `${list}?.closest('[role="dialog"]')`;
    const open = async () => {
      step = 'open-picker';
      await click(trigger);
      // A foreground activation can consume the first click on Windows. Only
      // retry this local toggle after observing that it is still closed.
      if (!(await read(`!!${list}`))) {
        await settle(1000);
        if (!(await read(`!!${list}`))) await click(trigger);
      }
      await until(`!!${list}`);
    };
    const search = async (value: string) => {
      // The long task sidebar can exhaust the default tree budget before the
      // portalled search input. Request that field explicitly before editing.
      const state = await call('get_window_state', {
        ...targetArgs,
        include_screenshot: false,
        query: '搜索项目',
        max_elements: 1000,
        max_depth: 25,
      });
      report.searchObservation = state.data;
      // Windows returns UIA `Edit`, not the macOS smoke's AXTextField. Use the
      // fresh public snapshot's row number, never a cached native element index.
      const input = String(state.data?.tree_markdown ?? '').match(
        /- \[(\d+)\] Edit "(搜索项目|Search projects)"/i,
      );
      assert(
        input && state.data?.snapshot_id,
        'Search field is missing from the real accessibility observation',
      );
      await call('set_value', {
        ...targetArgs,
        element_token: `${state.data.snapshot_id}:${input![1]}`,
        value,
      });
      await until(`${popup}.querySelector('input')?.value === ${JSON.stringify(value)}`);
      await settle();
    };
    const snap = async (name: string) => {
      const file = path.join(root, `${name}.png`);
      await fs.writeFile(file, (await window.webContents.capturePage()).toPNG());
      return file;
    };
    const wheel = async (
      name: string,
      selector: string,
      top: 'start' | 'end' | number = 0,
      direction = 'down',
    ) => {
      step = name;
      // Set only the initial position, never the result being asserted.
      await read(
        `(()=>{const l=${list}; l.scrollTop=${top === 'end' ? 'l.scrollHeight' : top === 'start' ? 0 : top};window.__folderWheelEvents=[];if(!window.__folderWheelObserver){window.__folderWheelObserver=true;document.addEventListener('wheel',e=>{const row={trusted:e.isTrusted,x:e.clientX,y:e.clientY,deltaY:e.deltaY,deltaMode:e.deltaMode,cancelable:e.cancelable,target:e.target.tagName,inList:!!e.target.closest('[data-folder-picker-scroll]')};setTimeout(()=>{row.prevented=e.defaultPrevented;window.__folderWheelEvents.push(row)},0);},{capture:true,passive:true})}})()`,
      );
      await settle();
      const before = await read(
        `(()=>{const l=${list};return {top:l.scrollTop,max:l.scrollHeight-l.clientHeight,page:document.scrollingElement.scrollTop}})()`,
      );
      await observe();
      const p = await point(selector);
      const inList = await read(`!!(${selector}).closest('[data-folder-picker-scroll]')`);
      const receipt = await call('scroll', {
        ...targetArgs,
        x: p.x,
        y: p.y,
        direction,
        amount: 1,
        by: 'line',
        delivery_mode: 'foreground',
      });
      await settle(1000);
      const after = await read(
        `(()=>{const l=${list};return {top:l.scrollTop,page:document.scrollingElement.scrollTop,events:window.__folderWheelEvents,theme:document.documentElement.className,viewport:[innerWidth,innerHeight]}})()`,
      );
      const delta = after.events.reduce(
        (n: number, e: { deltaY: number; deltaMode: number }) =>
          n +
          e.deltaY *
            (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.getContentBounds().height : 1),
        0,
      );
      const expected = Math.min(before.max, Math.max(0, before.top + delta));
      const passed =
        after.events.length > 0 &&
        after.events.every(
          (e: {
            trusted: boolean;
            x: number;
            y: number;
            inList: boolean;
            cancelable: boolean;
            prevented: boolean;
          }) =>
            e.trusted &&
            Math.abs(e.x - p.clientX) <= 2 &&
            Math.abs(e.y - p.clientY) <= 2 &&
            e.inList === inList &&
            e.prevented === (!inList && e.cancelable),
        ) &&
        Math.abs(after.top - expected) < 1 &&
        after.page === before.page &&
        after.theme.includes('dark') === name.startsWith('dark');
      const screenshot = await snap(name);
      checks.push({ name, point: p, before, after, delta, expected, passed, receipt, screenshot });
      await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      assert(passed, `${name}: native wheel displacement did not match one browser delta`);
      assert(errors.length === 0, `${name}: passive listener error`);
    };
    for (const theme of ['light', 'dark']) {
      // Fixture preference; reload lets the real theme service apply its tokens.
      await read(`localStorage.setItem('theme',${JSON.stringify(theme)})`);
      window.webContents.reload();
      await until(`location.hash.includes('/new') && !!${trigger}`);
      await settle(3500);
      await dismissCrashNotice();
      await open();
      const row = `${list}.querySelector('button')`;
      await wheel(`${theme}-row`, row);
      await wheel(`${theme}-row-icon`, `${row}.querySelector('svg')`);
      await wheel(`${theme}-heading`, `${popup}.querySelector('span')`);
      await wheel(`${theme}-search`, `${popup}.querySelector('input')`);
      await wheel(
        `${theme}-footer`,
        `[...${popup}.querySelectorAll('button')].find(e=>/选择其他项目文件夹|Browse project folder|Choose.*folder/i.test(e.textContent))`,
      );
      await wheel(`${theme}-bottom-boundary`, `${list}`, 'end');
      await wheel(`${theme}-top-boundary`, row, 'start', 'up');
      await key('Escape');
      await until(`!${list}`);
      await open();
      await wheel(`${theme}-reopened`, row);
      await search('wheel-project-00');
      assert(
        await read(
          `${list}.scrollHeight === ${list}.clientHeight && ${list}.querySelectorAll('button').length === 2`,
        ),
        'Search did not produce a single non-scrolling project row',
      );
      await wheel(`${theme}-short-row`, row);
      await wheel(`${theme}-short-heading`, `${popup}.querySelector('span')`);
      await search('no-matching-project-9695');
      assert(
        await read(`${list}.querySelectorAll('button').length === 0`),
        'Empty search still has projects',
      );
      await wheel(`${theme}-empty-search`, `${popup}.querySelector('input')`);
      await key('Escape');
      await until(`${popup}.querySelector('input')?.value === ''`);
      await key('Escape');
      window.setSize(1000, 700);
      await settle();
      await open();
      await wheel(`${theme}-small-row`, row);
      await wheel(`${theme}-small-search`, `${popup}.querySelector('input')`);
      await key('Escape');
      window.setSize(1280, 1000);
      await settle();
    }
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.step = step;
    if (!window.isDestroyed()) {
      report.page = await read(
        `({url:location.href,text:document.body.innerText.slice(0,6000)})`,
      ).catch(() => null);
      await fs
        .writeFile(path.join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG())
        .catch(() => undefined);
    }
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await cleanupComputerDriverSession(sessionId).catch(() => undefined);
    if (!window.isDestroyed())
      window.webContents.removeListener('console-message', consoleListener);
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  }
}
