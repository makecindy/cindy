/**
 * 伙伴设置「例行任务 → 夜间学习」用的固定 IPC：读状态、开关、频率、现在整理、撤销 / 恢复、观察中的做法。
 * 只服务本机受信任的应用窗口；参数在这里做运行期校验，错误按稳定代码返回，不带路径或原始报错。
 */
import { ipcMain } from 'electron';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import type { NightlyLearningView } from '../../shared/botNightlyLearning.js';
import { readNightlyLearningState } from '../maker-ipc/botNightlyLearningState.js';
import { routineTools } from './service.js';

const log = createLogger('nightly-learning-ipc');

const validBotId = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 128;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

async function readView(botId: string): Promise<NightlyLearningView> {
  const [routine, state, nightly, bot] = await Promise.all([
    routineTools.nightlyLearningRoutine(botId),
    readNightlyLearningState(ownerScopedUserDataPath(), botId),
    import('../maker-ipc/botNightlyLearning.js'),
    getDbClient().queryOne<{ capabilities: string }>(
      `SELECT v.capabilities_json AS capabilities FROM bot_profiles p
       JOIN bot_profile_versions v ON v.bot_id=p.id AND v.version=p.current_version WHERE p.id=?`,
      [botId],
    ),
  ]);
  let memoryEnabled = true;
  try { memoryEnabled = JSON.parse(bot?.capabilities || '{}').memory !== false; } catch { /* Defaults to on, as in settings. */ }
  return {
    enabled: routine ? routine.enabled : null,
    frequency: state?.frequency ?? 'daily',
    pendingTurns: state?.pending.turns ?? 0,
    running: nightly.isNightlyLearningRunning(botId) || routine?.activity === 'running',
    memoryEnabled,
    lastRun: state?.runs.find((run) => !run.manual || run.turns > 0 || run.outcome === 'failed') ?? null,
    runs: state?.runs ?? [],
    candidates: (state?.candidates ?? []).map(({ draft: _draft, ...candidate }) => candidate),
  };
}

export function registerNightlyLearningIpc(): void {
  const handle = (channel: string, run: (botId: string, ...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, botId: unknown, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      if (!validBotId(botId)) throwIpcError('INVALID_PARAMS', 'Invalid teammate');
      try {
        return await run(botId, ...args);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'CHANGED') throwIpcError('PRECONDITION_FAILED', 'This item was changed after nightly learning');
        if (code === 'NOT_FOUND') throwIpcError('NOT_FOUND', 'Nightly learning item not found');
        log.warn('nightly learning operation failed', { channel, error: String(error) });
        throwIpcError('INTERNAL', 'Nightly learning is unavailable right now');
      }
    });
  };
  handle('routines:nightly-learning:get', (botId) => readView(botId));
  handle('routines:nightly-learning:set-enabled', async (botId, enabled) => {
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid value');
    await routineTools.setNightlyLearning(botId, enabled);
    return readView(botId);
  });
  handle('routines:nightly-learning:set-frequency', async (botId, frequency) => {
    if (frequency !== 'daily' && frequency !== 'weekly') throwIpcError('INVALID_PARAMS', 'Invalid frequency');
    await routineTools.setNightlyLearningFrequency(botId, frequency);
    return readView(botId);
  });
  handle('routines:nightly-learning:run-now', async (botId) => {
    await routineTools.runNightlyLearningNow(botId);
    return readView(botId);
  });
  handle('routines:nightly-learning:revert', async (botId, runId, itemId, redo) => {
    if (!validId(runId) || !validId(itemId) || typeof redo !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid item');
    const { revertNightlyLearningItem } = await import('../maker-ipc/botNightlyLearning.js');
    await revertNightlyLearningItem(botId, runId, itemId, redo);
    return readView(botId);
  });
  handle('routines:nightly-learning:candidate', async (botId, candidateId, action) => {
    if (!validId(candidateId) || (action !== 'promote' && action !== 'decline')) throwIpcError('INVALID_PARAMS', 'Invalid candidate');
    const { resolveNightlyLearningCandidate } = await import('../maker-ipc/botNightlyLearning.js');
    await resolveNightlyLearningCandidate(botId, candidateId, action);
    return readView(botId);
  });
}
