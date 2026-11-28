// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudSettingsDomain, CloudSettingsState } from '../../../../shared/cloudSettings';

const calls: Array<{ channel: string; resolve: (state: unknown) => void }> = [];
vi.mock('../cloudImTarget', () => ({
  createCloudImCaller: () => (_call: string, channel: string) =>
    new Promise((resolve) => calls.push({ channel, resolve })),
}));
const { useCloudImDisplays } = await import('../CloudImSettings');
afterEach(() => {
  cleanup();
  calls.splice(0);
});
type States = Partial<Record<CloudSettingsDomain, CloudSettingsState>>;
const states = (revisions: Partial<Record<CloudSettingsDomain, string>>): States =>
  Object.fromEntries(
    Object.entries(revisions).map(([domain, revision]) => [domain, { domain, revision } as never]),
  );
const loaded = states({ imFeishu: 'r1', imDiscord: 'r1', imTelegram: 'r1' });

it('reads each channel once per visit and again only when its own revision changes', () => {
  const view = renderHook(
    ({ enabled, value }: { enabled: boolean; value: States }) =>
      useCloudImDisplays('cloud-a', enabled, value),
    { initialProps: { enabled: true, value: loaded } },
  );
  expect(calls).toHaveLength(6);
  // A reload or a save elsewhere hands over a new snapshot with the same IM revisions.
  view.rerender({ enabled: true, value: { ...loaded, memory: { revision: 'r9' } as never } });
  expect(calls).toHaveLength(6);
  view.rerender({ enabled: true, value: { ...loaded, imFeishu: { revision: 'r2' } as never } });
  expect(calls.slice(6).map(({ channel }) => channel)).toEqual(['feishu']);
  view.rerender({ enabled: false, value: loaded });
  view.rerender({ enabled: true, value: loaded });
  expect(calls).toHaveLength(13);
});

it('keeps the newest read of a channel and drops reads from an earlier visit', async () => {
  const view = renderHook(
    ({ enabled, value }: { enabled: boolean; value: States }) =>
      useCloudImDisplays('cloud-a', enabled, value),
    { initialProps: { enabled: true, value: loaded } },
  );
  view.rerender({ enabled: true, value: { ...loaded, imFeishu: { revision: 'r2' } as never } });
  const [first, , , , , , second] = calls;
  await act(async () => {
    second.resolve({ revision: 'new' });
    first.resolve({ revision: 'old' });
  });
  expect(view.result.current.feishu).toEqual({ revision: 'new' });
  const discord = calls[1];
  view.rerender({ enabled: false, value: loaded });
  await act(async () => discord.resolve({ revision: 'left' }));
  expect(view.result.current.discord).toBeUndefined();
});
