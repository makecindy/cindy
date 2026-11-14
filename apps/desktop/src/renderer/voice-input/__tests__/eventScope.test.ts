import { describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';
import { dispatchVoiceInputEvent, shouldHandleVoiceInputEvent } from '../eventScope';

const done = (runId: string): VoiceInputRendererEvent => ({ type: 'state', runId, state: 'done' });

// 测试价值：dispatchVoiceInputEvent 必须隔离不同录音的事件并保留当前录音的早到事件。
// 依据：2026-11-09 快速启停后麦克风持续占用；旧测试允许启动期间接收任意 run。
// 最小输入：owned=null，旧 done 与新 auth 先到，新 start 后完成。
// tier: unit，纯事件与 Promise，无设备/网络/真实计时；用例 2ms，组合运行墙钟 1.25s。
describe('voice input renderer event scope', () => {
  it('only accepts events for an owned run, including its terminal error details', () => {
    expect(shouldHandleVoiceInputEvent(null, 'old')).toBe(false);
    expect(shouldHandleVoiceInputEvent('new', 'old')).toBe(false);
    expect(shouldHandleVoiceInputEvent('new', 'new')).toBe(true);
  });

  it('waits for startup ownership, discards old events and preserves matching early events in order', async () => {
    let owned: string | null = null;
    let resolve!: (result: { ok: true; runId: string }) => void;
    const pending = new Promise<{ ok: true; runId: string }>((r) => { resolve = r; });
    const handle = vi.fn();
    const early: VoiceInputRendererEvent = {
      type: 'auth-required', runId: 'new', provider: 'codex', reason: 'expired',
    };
    for (const event of [done('old'), early, done('new')]) {
      dispatchVoiceInputEvent(event, () => owned, pending, handle);
    }
    expect(handle).not.toHaveBeenCalled();
    owned = 'new';
    resolve({ ok: true, runId: 'new' });
    await pending;
    expect(handle.mock.calls.map(([event]) => event)).toEqual([early, done('new')]);
  });

  it('drops events when startup fails or the subscriber no longer owns the resolved run', async () => {
    const handle = vi.fn();
    dispatchVoiceInputEvent(done('old'), () => null, Promise.resolve({ ok: false }), handle);
    dispatchVoiceInputEvent(done('old'), () => 'new', Promise.resolve({ ok: true, runId: 'old' }), handle);
    dispatchVoiceInputEvent(done('old'), () => null, undefined, handle);
    await Promise.resolve();
    expect(handle).not.toHaveBeenCalled();
  });
});
