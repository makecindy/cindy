import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewAutomation } from '../rsb-webview-automation.js';

interface DebuggerHarness {
  wc: WebContents;
  sendCommand: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

function debuggerHarness(
  handler: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>,
  alreadyAttached = false,
): DebuggerHarness {
  let attached = alreadyAttached;
  const attach = vi.fn(() => {
    attached = true;
  });
  const detach = vi.fn(() => {
    attached = false;
  });
  const sendCommand = vi.fn(handler);
  const executeJavaScript = vi.fn(async () => ({ ok: true }));
  const wc = {
    getURL: () => 'https://example.test/form',
    executeJavaScript,
    debugger: {
      isAttached: vi.fn(() => attached),
      attach,
      detach,
      sendCommand,
    },
  } as unknown as WebContents;
  return { wc, sendCommand, executeJavaScript, attach, detach };
}

function automation(): RsbWebviewAutomation {
  return new RsbWebviewAutomation({ warn: vi.fn() });
}

describe('RsbWebviewAutomation lifecycle', () => {
  it('fences a delayed debugger command without detaching its replacement generation', async () => {
    let finishOld: ((value: unknown) => void) | undefined;
    let finishReplacement: ((value: unknown) => void) | undefined;
    let commandCount = 0;
    const harness = debuggerHarness(() => {
      commandCount += 1;
      return new Promise((resolve) => {
        if (commandCount === 1) finishOld = resolve;
        else finishReplacement = resolve;
      });
    });
    const oldGeneration = automation();
    const replacement = automation();

    const oldCall = oldGeneration.evaluate('tab-1', harness.wc, {
      fn: '() => 1',
    });
    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledTimes(1));
    oldGeneration.dispose();

    const replacementCall = replacement.evaluate('tab-1', harness.wc, {
      fn: '() => 2',
    });
    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledTimes(2));

    finishOld?.({ result: { value: 1 } });
    await expect(oldCall).rejects.toThrow(/generation was replaced/);
    // Only dispose detached. The old call's late finally must not detach the
    // replacement generation that has since attached to the same transport.
    expect(harness.detach).toHaveBeenCalledTimes(1);

    finishReplacement?.({ result: { value: 2 } });
    await expect(replacementCall).resolves.toBe(2);
    expect(harness.detach).toHaveBeenCalledTimes(2);
  });
});

const AX_TREE = {
  nodes: [
    {
      nodeId: 'root',
      role: { value: 'RootWebArea' },
      name: { value: 'Example' },
      backendDOMNodeId: 1,
      childIds: ['button', 'textbox'],
    },
    {
      nodeId: 'button',
      role: { value: 'button' },
      name: { value: 'Submit' },
      backendDOMNodeId: 2,
      childIds: [],
    },
    {
      nodeId: 'textbox',
      role: { value: 'textbox' },
      name: { value: 'Email' },
      value: { value: 'old@example.test' },
      backendDOMNodeId: 3,
      childIds: [],
    },
  ],
};

describe('RsbWebviewAutomation snapshot', () => {
  it('builds an AI role snapshot with actionable refs and releases its debugger', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      interactive: true,
    });

    expect(result).toMatchObject({
      format: 'ai',
      targetId: 'tab-1',
      url: 'https://example.test/form',
      refs: {
        e1: { role: 'button', name: 'Submit', backendDOMNodeId: 2 },
        e2: { role: 'textbox', name: 'Email', backendDOMNodeId: 3 },
      },
      stats: { refs: 2, interactive: 2 },
    });
    expect(result.snapshot).toContain('- button "Submit" [ref=e1]');
    expect(result.snapshot).toContain('- textbox "Email" [ref=e2]');
    expect(harness.attach).toHaveBeenCalledWith('1.3');
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });

  it('supports aria output, selector scoping and limits', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'selector-object' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getPartialAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      snapshotFormat: 'aria',
      selector: '#form',
      limit: 1,
    });

    expect(result.format).toBe('aria');
    expect(result.nodes).toHaveLength(1);
    expect(harness.sendCommand).toHaveBeenCalledWith('Accessibility.getPartialAXTree', {
      backendNodeId: 2,
      fetchRelatives: true,
    });
    expect(harness.sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'selector-object',
    });
  });

  it('returns a bounded resource list and authorizes only the latest snapshot URLs', async () => {
    const instance = automation();
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') {
        expect(params?.expression).toContain('document.querySelectorAll');
        return {
          result: {
            value: {
              resources: [
                {
                  kind: 'image',
                  url: 'https://cdn.example.test/image.png',
                  label: 'Preview',
                },
              ],
            },
          },
        };
      }
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await instance.snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      urls: true,
    });

    expect(result.resources).toEqual([
      {
        kind: 'image',
        url: 'https://cdn.example.test/image.png',
        label: 'Preview',
      },
    ]);
    expect(() =>
      instance.assertResource('tab-1', 'https://cdn.example.test/image.png'),
    ).not.toThrow();
    expect(() => instance.assertResource('tab-1', 'https://other.example.test/file.zip')).toThrow(
      'not present in the latest page resource list',
    );
  });

  it('returns a structured verification barrier without creating action refs', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              resources: [],
              barrier: {
                kind: 'human-verification',
                evidence: ['page contains a verification control'],
              },
            },
          },
        };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
    });

    expect(result).toMatchObject({
      barrier: {
        kind: 'human-verification',
        evidence: ['page contains a verification control'],
      },
      stats: { refs: 0, interactive: 0 },
    });
    expect(harness.sendCommand).not.toHaveBeenCalledWith('Accessibility.enable');
  });
});

describe('RsbWebviewAutomation act', () => {
  it('rejects negative element query indexes before polling the page', async () => {
    const harness = debuggerHarness(async () => {
      throw new Error('query should fail before debugger evaluation');
    });

    await expect(
      automation().act('tab-1', harness.wc, {
        kind: 'click',
        query: { role: 'button', index: -1 },
      }),
    ).rejects.toThrow('element query index must be a non-negative integer');
    expect(harness.sendCommand).not.toHaveBeenCalled();
  });

  it('uses native keyboard input for browser-default navigation keys', async () => {
    const harness = debuggerHarness(async () => {
      throw new Error('unexpected debugger command');
    });
    const sendInputEvent = vi.fn();
    Object.assign(harness.wc, { sendInputEvent });

    await automation().act(
      'tab-1',
      harness.wc,
      {
        kind: 'press',
        key: 'Ctrl+A',
      },
      {
        nativeKeyDispatch: async (type, keyCode, modifiers) => {
          sendInputEvent({ type, keyCode, modifiers });
        },
      },
    );

    expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: 'keyDown',
      keyCode: 'A',
      modifiers: ['control'],
    });
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: 'keyUp',
      keyCode: 'A',
      modifiers: ['control'],
    });
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain('"type":"validate"');
  });

  it('treats maxChars zero as unlimited', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      maxChars: 0,
    });

    expect(result.snapshot).toContain('[ref=e1]');
    expect(result.stats.lines).toBeGreaterThan(0);
  });

  it('applies efficient snapshot defaults and rejects unsupported labels', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      throw new Error(`unexpected command: ${method} ${JSON.stringify(params)}`);
    });

    const efficient = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      mode: 'efficient',
    });
    expect(efficient.snapshot).toContain('[ref=e1]');
    expect(efficient.stats.lines).toBeGreaterThan(0);

    await expect(
      automation().snapshot('tab-1', harness.wc, {
        action: 'snapshot',
        labels: true,
      }),
    ).rejects.toThrow('snapshot labels are unavailable');
  });

  it('scopes snapshots to the requested frame', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'frame-object' } };
      if (method === 'DOM.describeNode') {
        expect(params).toMatchObject({ backendNodeId: 20, depth: 1 });
        return {
          node: {
            frameId: 'frame-owner',
            contentDocument: { frameId: 'frame-document', nodeId: 21 },
          },
        };
      }
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') {
        expect(params).toEqual({ frameId: 'frame-document' });
        return AX_TREE;
      }
      throw new Error(`unexpected command: ${method}`);
    });
    harness.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'frame-object' } };
      if (method === 'DOM.describeNode' && params?.objectId === 'frame-object') {
        return { node: { backendNodeId: 20 } };
      }
      if (method === 'DOM.describeNode' && params?.backendNodeId === 20) {
        return {
          node: {
            frameId: 'frame-owner',
            contentDocument: { frameId: 'frame-document', nodeId: 21 },
          },
        };
      }
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') {
        expect(params).toEqual({ frameId: 'frame-document' });
        return AX_TREE;
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      frame: 'iframe#widget',
    });

    expect(result).toMatchObject({ stats: { refs: 2 } });
    expect(harness.sendCommand).toHaveBeenCalledWith('Accessibility.getFullAXTree', {
      frameId: 'frame-document',
    });
  });

  it('clicks a snapshot ref at the center of its DOM box', async () => {
    const instance = automation();
    let phase: 'snapshot' | 'click' = 'snapshot';
    const harness = debuggerHarness(async (method) => {
      if (phase === 'snapshot') {
        if (method === 'Accessibility.enable') return {};
        if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      } else {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'button-object' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        }
      }
      throw new Error(`unexpected command during ${phase}: ${method}`);
    });
    await instance.snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      interactive: true,
    });
    phase = 'click';
    harness.sendCommand.mockClear();

    const result = await instance.act('tab-1', harness.wc, {
      kind: 'click',
      ref: 'e1',
    });

    expect(result).toMatchObject({ tabId: 'tab-1', kind: 'click', x: 20, y: 30 });
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    );
    expect(harness.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mousePressed"',
    );
    expect(harness.executeJavaScript.mock.calls[0][1]).toBe(false);
    expect(harness.executeJavaScript.mock.calls[1][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mouseReleased"',
    );
    expect(harness.executeJavaScript.mock.calls[1][1]).toBe(true);
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Runtime.releaseObject',
      { objectId: 'button-object' },
    );
  });

  it('types into a selector and optionally submits', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input-object' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 5 } };
      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params?.functionDeclaration ?? '');
        return {
          result: {
            value:
              declaration.includes('options.editable') ||
              declaration.includes('function(requireEditable)')
                ? { ok: true }
                : false,
          },
        };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'type',
      selector: 'input[type=email]',
      text: 'hello@example.test',
      submit: true,
    });

    expect(result).toMatchObject({
      tabId: 'tab-1',
      kind: 'type',
      textLength: 18,
    });
    expect(harness.executeJavaScript).toHaveBeenCalledTimes(3);
    const insertTextCall = harness.executeJavaScript.mock.calls.find(([script]) =>
      String(script).includes('"method":"Input.insertText","params":{"text":"hello@example.test"}'),
    );
    expect(insertTextCall?.[0]).toContain('"targetTicket":"rsb-');
    const enterKeyDownCall = harness.executeJavaScript.mock.calls.find(([script]) =>
      String(script).includes(
        '"method":"Input.dispatchKeyEvent","params":{"type":"keyDown","key":"Enter"',
      ),
    );
    expect(enterKeyDownCall).toBeDefined();
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Input\./),
      expect.anything(),
    );
  });

  it('fills browser-native date inputs', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'date-input' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 6 } };
      if (method === 'Runtime.callFunctionOn') {
        if (String(params?.functionDeclaration).includes('requireEditable')) {
          expect(String(params?.functionDeclaration)).toContain('"date", "datetime-local"');
        }
        return { result: { value: { ok: true } } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'fill',
      selector: 'input[type=date]',
      text: '2026-07-27',
    });

    expect(result).toMatchObject({ kind: 'fill', textLength: 10 });
    const fillCall = harness.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' &&
        String((params as { functionDeclaration?: unknown })?.functionDeclaration).includes(
          'const type =',
        ),
    );
    expect(fillCall?.[1]).toMatchObject({
      arguments: [{ value: '2026-07-27' }, { value: undefined }],
    });
    expect(fillCall).toBeDefined();
  });

  it('fills the shared multi-field form shape', async () => {
    const instance = automation();
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'field-object' } };
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 6 } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'field-object' } };
      if (method === 'Runtime.callFunctionOn') {
        if (String(params?.functionDeclaration).includes('const type =')) {
          expect(params?.arguments).toEqual([{ value: 'Ada' }, { value: 'text' }]);
          return { result: { value: undefined } };
        }
        return { result: { value: { ok: true } } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await instance.snapshot('tab-1', harness.wc, {
      action: 'snapshot',
      interactive: true,
    });
    const result = await instance.act('tab-1', harness.wc, {
      kind: 'fill',
      fields: [{ ref: 'e2', type: 'text', value: 'Ada' }],
    });

    expect(result).toMatchObject({ kind: 'fill', filled: 1 });
    const fillCall = harness.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' &&
        String((params as { functionDeclaration?: string })?.functionDeclaration).includes(
          'HTMLInputElement.prototype',
        ),
    );
    expect(fillCall).toBeDefined();
  });

  it('hovers without focusing the target', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'hover-target' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 9 } };
      if (method === 'Runtime.callFunctionOn') {
        expect(String(params?.functionDeclaration)).not.toContain('this.focus()');
        return { result: { value: { ok: true } } };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(
      automation().act('tab-1', harness.wc, {
        kind: 'hover',
        selector: '#hover-target',
      }),
    ).resolves.toMatchObject({ kind: 'hover', x: 10, y: 5 });
  });

  it('resolves a semantic query and waits for an actionable target', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') {
        expect(params?.expression).toContain('"role":"button"');
        expect(params?.expression).toContain('"name":"Continue"');
        return { result: { objectId: 'button-object' } };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 7 } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'click',
      query: { role: 'button', name: 'Continue', exact: true },
      timeoutMs: 750,
    });

    expect(result).toMatchObject({ kind: 'click', x: 10, y: 5 });
    const pageCalls = harness.sendCommand.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(
      pageCalls.some(([, params]) =>
        String(params?.functionDeclaration).includes('target is not visible'),
      ),
    ).toBe(true);
  });

  it('surfaces page-side query failures before attempting input', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') {
        return {
          result: { subtype: 'error' },
          exceptionDetails: {
            exception: { description: 'Error: element query matched 2 elements; provide index' },
          },
        };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(
      automation().act('tab-1', harness.wc, {
        kind: 'click',
        query: { role: 'button', name: 'Continue' },
      }),
    ).rejects.toThrow('element query matched 2 elements; provide index');
    expect(harness.executeJavaScript).not.toHaveBeenCalled();
  });

  it('rejects query options that do not identify an element', async () => {
    const harness = debuggerHarness(async (method) => {
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(
      automation().act('tab-1', harness.wc, {
        kind: 'click',
        query: { exact: true, index: 0 },
      }),
    ).rejects.toThrow('element query requires at least one field');
    expect(harness.sendCommand).not.toHaveBeenCalled();
  });

  it('resets an overridden viewport when resize omits dimensions', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') return {};
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, { kind: 'resize' });

    expect(result).toMatchObject({ kind: 'resize', reset: true });
    expect(harness.sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride');
  });

  it('sets validated files on a resolved file input', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 12 } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, multiple: true } } };
      }
      if (method === 'DOM.setFileInputFiles') return {};
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().setFiles('tab-1', harness.wc, {
      paths: ['C:\\safe\\one.txt', 'C:\\safe\\two.txt'],
      query: { label: 'Attachments' },
    });

    expect(result).toEqual({ tabId: 'tab-1', uploadedFiles: 2 });
    expect(harness.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
      files: ['C:\\safe\\one.txt', 'C:\\safe\\two.txt'],
      objectId: 'file-input',
    });
  });

  it('does not place multiple files into a single-file input', async () => {
    const harness = debuggerHarness(async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 12 } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, multiple: false } } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    await expect(
      automation().setFiles('tab-1', harness.wc, {
        paths: ['C:\\safe\\one.txt', 'C:\\safe\\two.txt'],
        element: 'input[type=file]',
      }),
    ).rejects.toThrow('accepts only one file');
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      'DOM.setFileInputFiles',
      expect.anything(),
    );
  });

  it('dispatches coordinate clicks without requiring a snapshot', async () => {
    const harness = debuggerHarness(async (method) => {
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'clickCoords',
      x: 12.5,
      y: 24,
      button: 'right',
    });

    expect(result).toMatchObject({ kind: 'clickCoords', x: 12.5, y: 24 });
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain(
      '"method":"Input.dispatchMouseEvent","params":{"type":"mousePressed"',
    );
    expect(harness.executeJavaScript.mock.calls[0][0]).toContain('"button":"right"');
  });

  it('waits for page conditions inside the guest and returns observed state', async () => {
    const harness = debuggerHarness(async (method, params) => {
      if (method === 'Runtime.evaluate') {
        expect(params?.expression).toContain('"selector":"#ready"');
        return { result: { value: { url: 'https://example.test/form', readyState: 'complete' } } };
      }
      throw new Error(`unexpected command: ${method}`);
    });

    const result = await automation().act('tab-1', harness.wc, {
      kind: 'wait',
      selector: '#ready',
      loadState: 'load',
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      kind: 'wait',
      state: { url: 'https://example.test/form', readyState: 'complete' },
    });
  });

  it('rejects stale refs and still detaches the debugger', async () => {
    const harness = debuggerHarness(async () => {
      throw new Error('sendCommand should not run');
    });

    await expect(
      automation().act('tab-1', harness.wc, { kind: 'click', ref: 'e999' }),
    ).rejects.toThrow(/unknown or stale snapshot ref/);
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });
});
