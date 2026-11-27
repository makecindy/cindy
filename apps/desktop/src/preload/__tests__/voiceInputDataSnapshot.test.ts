import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputDataSnapshot } from '../../shared/voiceInputData';

const ipc = vi.hoisted(() => ({ sendSync: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));
import { createVoiceInputDataSnapshot } from '../voiceInputDataSnapshot';

// BWG3 unit regression: repeated settings reads on hover/render waited for Main.
// Existing settings tests replace the whole bridge and cannot observe IPC or
// account changes. This preload fixture isolates Electron, not the renderer DOM.
const snapshot = (text: string) => ({ settings: { language: text }, history: [] }) as unknown as VoiceInputDataSnapshot;
beforeEach(() => { ipc.sendSync.mockReset(); ipc.on.mockReset(); });
describe('voice input data snapshot', () => {
  it('reads locally and applies host changes before subsequent reads', () => {
    ipc.sendSync.mockReturnValue(snapshot('auto'));
    const cache = createVoiceInputDataSnapshot();
    expect(cache.read()).toEqual(snapshot('auto'));
    expect(cache.read()).toEqual(snapshot('auto'));
    ipc.on.mock.calls.find(([name]) => name === 'voice-input:data-changed')![1]({}, snapshot('zh'));
    expect(cache.read()).toEqual(snapshot('zh'));
    expect(ipc.sendSync).toHaveBeenCalledTimes(1);
    cache.replace(snapshot('en'));
    expect(cache.read()).toEqual(snapshot('en'));
  });
  it('refreshes at authentication boundaries instead of retaining the previous owner', () => {
    ipc.sendSync.mockReturnValueOnce(snapshot('old')).mockReturnValueOnce(snapshot('new'));
    const cache = createVoiceInputDataSnapshot();
    ipc.on.mock.calls.find(([name]) => name === 'auth:state-change')![1]({});
    expect(cache.read()).toEqual(snapshot('new'));
    expect(ipc.sendSync).toHaveBeenCalledTimes(2);
  });
  it('does not expose the previous owner when refreshing fails, and recovers on a host update', () => {
    ipc.sendSync.mockReturnValueOnce(snapshot('old')).mockImplementationOnce(() => { throw new Error('disconnected'); });
    const cache = createVoiceInputDataSnapshot();
    expect(() => ipc.on.mock.calls.find(([name]) => name === 'auth:state-change')![1]({})).not.toThrow();
    expect(cache.read).toThrow('disconnected');
    ipc.on.mock.calls.find(([name]) => name === 'voice-input:data-changed')![1]({}, snapshot('new'));
    expect(cache.read()).toEqual(snapshot('new'));
  });
});
