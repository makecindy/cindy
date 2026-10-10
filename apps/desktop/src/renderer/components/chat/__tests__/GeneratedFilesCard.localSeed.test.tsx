// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import {
  _clearLocalGeneratedFileStatCache,
  GeneratedFilesCard,
  seedLocalGeneratedFilesFromStatCache,
} from '../GeneratedFilesCard';
import type { GeneratedFileRef } from '@/lib/generatedFiles';

vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({ menu: null, onContextMenu: vi.fn() }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const START = 1_000_000;
const report: GeneratedFileRef = {
  path: 'C:\\work\\report.md',
  name: 'report.md',
  source: 'tool',
  ready: true,
};

function stubStat(statPath: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { fsBrowse: { statPath } },
  });
}

function renderCard(props: {
  renderItemKey: string;
  files?: readonly GeneratedFileRef[];
  turnStartMs: number;
  turnEndMs?: number | null;
  botArtifacts?: boolean;
  onVisibilityChange?: (checkKey: string, visible: boolean) => void;
}) {
  return render(cardElement(props));
}

function cardElement(props: {
  renderItemKey: string;
  files?: readonly GeneratedFileRef[];
  turnStartMs: number;
  turnEndMs?: number | null;
  botArtifacts?: boolean;
  onVisibilityChange?: (checkKey: string, visible: boolean) => void;
}) {
  return (
    <ChatSessionFileProvider
      value={{ sessionId: 'local-task', workingDir: 'C:\\work', origin: { kind: 'local' } }}
    >
      <GeneratedFilesCard
        renderItemKey={props.renderItemKey}
        files={props.files ?? [report]}
        turnStartMs={props.turnStartMs}
        turnEndMs={props.turnEndMs ?? null}
        botArtifacts={props.botArtifacts}
        onVisibilityChange={props.onVisibilityChange}
      />
    </ChatSessionFileProvider>
  );
}

afterEach(() => {
  cleanup();
  _clearLocalGeneratedFileStatCache();
  vi.unstubAllGlobals();
});

describe('local generated files remount', () => {
  it('keeps the first paint empty until a path has been checked once', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.queryByText('report.md')).toBeNull();
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
  });

  it('renders a remounted card immediately when an earlier history page moves the turn start', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // Prepending older rows of the same open turn changes its key and widens the window.
    renderCard({ renderItemKey: 'genfiles-older', turnStartMs: START - 60_000 });
    expect(screen.getByText('report.md')).toBeTruthy();
    // The cached conclusion only bridges the paint; the new instance still re-checks.
    await waitFor(() => expect(statPath).toHaveBeenCalledTimes(2));
  });

  it('removes a seeded chip when the re-check finds the file gone', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 })
      .mockResolvedValueOnce({ kind: 'missing' });
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.getByText('report.md')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('report.md')).toBeNull());
  });

  it('keeps a seeded chip non-interactive until its re-check lands', async () => {
    const pendingStat: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingStat.push(resolve);
        }),
    );
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(pendingStat).toHaveLength(1));
    pendingStat[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // The seeded chip holds the row height, but a stale stat must not make it
    // clickable: DESIGN.md §14.5 decides local clickability by a real check.
    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    const seeded = screen.getByText('report.md').closest('button');
    expect(seeded).not.toBeNull();
    expect(seeded!.disabled).toBe(true);
    await waitFor(() => expect(pendingStat).toHaveLength(2));
    pendingStat[1]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() =>
      expect(screen.getByText('report.md').closest('button')!.disabled).toBe(false),
    );
  });

  it('does not render a stale bot image thumbnail while its seeded chip is pending', async () => {
    const picture: GeneratedFileRef = {
      path: 'C:\\work\\pic.png',
      name: 'pic.png',
      source: 'tool',
      ready: true,
    };
    const pendingStat: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingStat.push(resolve);
        }),
    );
    stubStat(statPath);
    const first = renderCard({
      renderItemKey: 'genfiles-a',
      files: [picture],
      turnStartMs: START,
      botArtifacts: true,
    });
    await waitFor(() => expect(pendingStat).toHaveLength(1));
    pendingStat[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(screen.getByText('pic.png')).toBeTruthy());
    first.unmount();

    // A re-mounted seeded chip is disabled, but DESIGN.md §14.5 also bars
    // loading the file's content before the recheck lands: a deleted or
    // replaced image at the same path must not flash through <img src>.
    renderCard({
      renderItemKey: 'genfiles-a',
      files: [picture],
      turnStartMs: START,
      botArtifacts: true,
    });
    expect(screen.getByText('pic.png')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    await waitFor(() => expect(pendingStat).toHaveLength(2));
    pendingStat[1]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  });

  it('does not let a stale cancelled stat overwrite a fresher cache verdict', async () => {
    const pendingStat: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingStat.push(resolve);
        }),
    );
    stubStat(statPath);

    const { rerender, unmount } = render(
      cardElement({ renderItemKey: 'genfiles-a', turnStartMs: START, turnEndMs: null }),
    );
    await waitFor(() => expect(pendingStat).toHaveLength(1));

    // The turn boundary lands mid-check: the in-flight check is cancelled and
    // a fresh one starts for the same path.
    rerender(
      cardElement({ renderItemKey: 'genfiles-a', turnStartMs: START, turnEndMs: START + 10_000 }),
    );
    await waitFor(() => expect(pendingStat).toHaveLength(2));

    // The fresh check lands first and finds the file gone.
    pendingStat[1]({ kind: 'missing' });
    await waitFor(() => expect(screen.queryByText('report.md')).toBeNull());

    // The stale, already-cancelled check now resolves with a stat that would
    // wrongly confirm the file. It must not win the race against the fresher
    // 'missing' verdict already recorded above.
    pendingStat[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await Promise.resolve();
    expect(screen.queryByText('report.md')).toBeNull();
    unmount();

    // A fresh remount under the same turn window must not be seeded from the
    // stale cached stat; the module cache should still hold the fresher
    // 'missing' verdict, not the cancelled check's 'file' result.
    render(
      cardElement({ renderItemKey: 'genfiles-b', turnStartMs: START, turnEndMs: START + 10_000 }),
    );
    expect(screen.queryByText('report.md')).toBeNull();
  });

  it('does not report a seeded-but-pending chip as a confirmed visibility', async () => {
    const pendingStat: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingStat.push(resolve);
        }),
    );
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(pendingStat).toHaveLength(1));
    pendingStat[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // The chip itself is seeded and shown immediately, but it is not a fresh
    // confirmation: useBotGeneratedFileDeliveries already keeps a prior true
    // confirmation across a remount on its own, so a bare unconfirmed seed
    // must not actively assert a *new* true (chatgpt-codex-connector P2,
    // botConversationPresentation.ts) before this mount's own recheck lands.
    const onVisibilityChange = vi.fn();
    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START, onVisibilityChange });
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(onVisibilityChange).not.toHaveBeenCalled();
    await waitFor(() => expect(pendingStat).toHaveLength(2));
    pendingStat[1]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith(expect.any(String), true));
  });

  it('re-checks a seeded path when another file finishes during the first check', async () => {
    const notes: GeneratedFileRef = {
      path: 'C:\\work\\notes.md',
      name: 'notes.md',
      source: 'tool',
      ready: true,
    };
    const pending: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn((path: string) =>
      path === notes.path
        ? Promise.resolve({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 })
        : new Promise((resolve) => {
            pending.push(resolve);
          }),
    );
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // Remount seeds report.md from the stat cache; its re-check hangs mid-turn.
    const second = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.getByText('report.md')).toBeTruthy();
    await waitFor(() => expect(pending).toHaveLength(2));
    // notes.md finishes while the seeded re-check is still in flight. The check
    // fingerprint changes and cancels that run before its verdict can land.
    second.rerender(cardElement({ renderItemKey: 'genfiles-a', turnStartMs: START, files: [report, notes] }));
    await waitFor(() => expect(pending).toHaveLength(3));
    // The replacement re-check still verifies the seeded path and finds it gone.
    pending[2]({ kind: 'missing' });
    await waitFor(() => expect(screen.queryByText('report.md')).toBeNull());
    expect(screen.getByText('notes.md')).toBeTruthy();
  });

  it('applies the current turn window to cached stats', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    const first = renderCard({
      renderItemKey: 'genfiles-a',
      turnStartMs: START,
      turnEndMs: START + 60_000,
    });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // A later turn that touches the same path must not inherit the earlier turn's file.
    expect(seedLocalGeneratedFilesFromStatCache([report], START + 120_000, null)).toBeNull();
    expect(seedLocalGeneratedFilesFromStatCache([report], START - 60_000, START + 60_000)).toEqual([
      report,
    ]);
  });

  it('does not seed from local stats for remote sessions', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    const chatStat = vi.fn(() => new Promise(() => {}));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { fsBrowse: { statPath }, fileBrowser: { chatStat } },
    });
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 'remote-task',
          workingDir: 'C:\\work',
          origin: { kind: 'device', deviceId: 'host' },
        }}
      >
        <GeneratedFilesCard
          renderItemKey="genfiles-a"
          files={[report]}
          turnStartMs={START}
          turnEndMs={null}
        />
      </ChatSessionFileProvider>,
    );
    expect(screen.queryByText('report.md')).toBeNull();
  });
});
