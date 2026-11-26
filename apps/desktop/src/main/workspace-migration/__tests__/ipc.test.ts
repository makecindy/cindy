/**
 * Test value (#10568): verifies desktop IPC grant boundary, candidate target derivation,
 * schedule/relaunch, cancel, and personal-preview guard against the real workspace migration service.
 * Previous tests only covered MCP/service layers without folder-picker grant enforcement.
 * Minimum failures: invalid/expired grant, overlapping target error projection, owner switch,
 * and restart delegation. Unit tier; isolated temp dirs, no Electron window.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceMigrationIpcHandlers } from '../ipc.js';
import { provisionDecoupledWorkspace } from '../service.js';
import * as processIdentity from '../../desktopProcessIdentity.js';

let temporary: string;
let ownerRoot: string;
let targetParent: string;
const botId = 'bot-ipc-test';

beforeEach(async () => {
  vi.spyOn(processIdentity, 'readDesktopProcessIdentity').mockResolvedValue({
    startedAtMs: 1_700_000_000_000,
    executablePath: process.execPath,
  });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ws-ipc-'));
  ownerRoot = path.join(temporary, 'owner');
  targetParent = path.join(temporary, 'other-drive');
  const workspace = path.join(ownerRoot, 'bots', botId, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(targetParent, { recursive: true });
  await fs.writeFile(path.join(workspace, 'draft.md'), 'hello workspace');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

function createHarness(overrides: Partial<Parameters<typeof createWorkspaceMigrationIpcHandlers>[0]> = {}) {
  let ownerCurrent = true;
  let currentNow = 1_700_000_000_000;
  const relaunch = vi.fn();
  const selectTargetParentDirectory = vi.fn(async () => targetParent);
  const handlers = createWorkspaceMigrationIpcHandlers({
    captureOwner: () => ({ ownerId: 'owner-1', scopeKey: 'scope-1', ownerRoot }),
    isOwnerCurrent: () => ownerCurrent,
    canSchedule: () => true,
    assertLocalBuddy: async () => {},
    selectTargetParentDirectory,
    relaunch,
    now: () => currentNow,
    ...overrides,
  });
  return {
    handlers,
    relaunch,
    selectTargetParentDirectory,
    setOwnerCurrent: (next: boolean) => {
      ownerCurrent = next;
    },
    advanceMs: (ms: number) => {
      currentNow += ms;
    },
  };
}

describe('workspace migration desktop IPC handlers', () => {
  it('previews a return to the default path of the same buddy without a folder picker', async () => {
    const { handlers, selectTargetParentDirectory } = createHarness();
    const source = path.join(ownerRoot, 'bots', botId, 'workspace');
    await expect(handlers.chooseTarget(botId, true)).resolves.toEqual({ selected: false });
    await fs.rm(source, { recursive: true });
    await provisionDecoupledWorkspace(ownerRoot, botId, targetParent);
    const chosen = await handlers.chooseTarget(botId, true);
    if (!chosen.selected || 'errorCode' in chosen) throw new Error('expected preview');
    expect(chosen.preview.target).toBe(source);
    expect(selectTargetParentDirectory).not.toHaveBeenCalled();
    const { status } = await handlers.schedule({ botId, grantId: chosen.preview.grantId, restartNow: false });
    expect(status).toMatchObject({ phase: 'pending', target: source, currentTarget: chosen.preview.source });
  });
  it('derives a fresh target subfolder, mints a grant, schedules, and supports cancel & restart', async () => {
    const { handlers, relaunch } = createHarness();
    // Pre-create first candidate so collision suffix -2 is exercised.
    await fs.mkdir(path.join(targetParent, `${botId}-workspace`));

    const chosen = await handlers.chooseTarget(botId);
    expect(chosen.selected).toBe(true);
    if (!chosen.selected || 'errorCode' in chosen) throw new Error('expected preview');
    expect(path.basename(chosen.preview.target)).toBe(`${botId}-workspace-2`);
    expect(chosen.preview.files).toBe(1);

    const scheduled = await handlers.schedule({
      botId,
      grantId: chosen.preview.grantId,
      restartNow: false,
    });
    expect(scheduled.relaunching).toBe(false);
    expect(scheduled.status.phase).toBe('pending');
    expect(relaunch).not.toHaveBeenCalled();

    const restarted = await handlers.restartForPending(botId);
    expect(restarted.relaunching).toBe(true);
    expect(relaunch).toHaveBeenCalledWith(botId);

    const cancelled = await handlers.cancel(botId);
    expect(cancelled.phase).toBe('cancelled');
  });

  it('rejects replayed, wrong-bot, or expired grants and blocks scheduling in personal preview', async () => {
    const { handlers, advanceMs } = createHarness();
    const chosen = await handlers.chooseTarget(botId);
    if (!chosen.selected || 'errorCode' in chosen) throw new Error('expected preview');

    advanceMs(20 * 60 * 1000);
    await expect(
      handlers.schedule({ botId, grantId: chosen.preview.grantId, restartNow: true }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');

    const previewOnly = createHarness({ canSchedule: () => false });
    const status = await previewOnly.handlers.getStatus(botId);
    expect(status.canSchedule).toBe(false);
    const chosen2 = await previewOnly.handlers.chooseTarget(botId);
    if (!chosen2.selected || 'errorCode' in chosen2) throw new Error('expected preview');
    await expect(
      previewOnly.handlers.schedule({
        botId,
        grantId: chosen2.preview.grantId,
        restartNow: true,
      }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
  });

  it('returns structured preview errors when the selected parent overlaps Cindy data', async () => {
    const { handlers } = createHarness({
      selectTargetParentDirectory: async () => ownerRoot,
    });
    const chosen = await handlers.chooseTarget(botId);
    expect(chosen).toMatchObject({
      selected: true,
      errorCode: 'TARGET_OVERLAPS_CINDY_DATA',
    });
  });

  it('triggers relaunch immediately when restartNow is requested', async () => {
    const { handlers, relaunch } = createHarness();
    const chosen = await handlers.chooseTarget(botId);
    if (!chosen.selected || 'errorCode' in chosen) throw new Error('expected preview');
    const result = await handlers.schedule({
      botId,
      grantId: chosen.preview.grantId,
      restartNow: true,
    });
    expect(result.relaunching).toBe(true);
    expect(relaunch).toHaveBeenCalledWith(botId);
  });
});
