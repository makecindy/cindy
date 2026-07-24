/**
 * nodeRuntimeWorkerProcess.test — utilityProcess child mode 的端口生命周期回归测试。
 */

import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GHOST_NODE_CHILD_MODE_FLAG } from '../../../shared/ghost';

type ParentMessageListener = (event: { data: unknown }) => void;

const originalArgv = process.argv;
const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreProcessProperty(name: 'stdin' | 'parentPort', descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(process, name, descriptor);
  } else {
    delete (process as unknown as Record<string, unknown>)[name];
  }
}

afterEach(() => {
  process.argv = originalArgv;
  restoreProcessProperty('stdin', originalStdin);
  restoreProcessProperty('parentPort', originalParentPort);
  vi.resetModules();
});

describe('nodeRuntimeWorkerProcess · child mode 生命周期', () => {
  it('收到 stdin-end 后解除 ParentPort 监听，让一次性 CLI 能自然退出', async () => {
    const listeners = new Set<ParentMessageListener>();
    const parentPort = {
      postMessage: vi.fn(),
      on: vi.fn((_event: 'message', listener: ParentMessageListener) => {
        listeners.add(listener);
      }),
      off: vi.fn((_event: 'message', listener: ParentMessageListener) => {
        listeners.delete(listener);
      }),
    };
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: parentPort,
    });
    process.argv = [
      process.execPath,
      'nodeRuntimeWorkerProcess.js',
      path.join(__dirname, 'fixtures/nodeRuntimeExitImmediately.cjs'),
      GHOST_NODE_CHILD_MODE_FLAG,
    ];

    await import('../nodeRuntimeWorkerProcess');

    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(listeners).toHaveLength(1);
    const [listener] = listeners;
    listener({ data: { type: 'stdin-end' } });
    expect(parentPort.off).toHaveBeenCalledWith('message', listener);
    expect(listeners).toHaveLength(0);
  });
});
