import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPromptPredictionSessionStopped,
  notePromptPredictionSessionStopped,
  resetPromptPredictionStopLedgerForTests,
  wasPromptPredictionSessionStopped,
} from '../promptPredictionStopLedger.js';

const REGISTER_SOURCE = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');

beforeEach(() => {
  resetPromptPredictionStopLedgerForTests();
});

describe('prompt prediction explicit Stop ledger', () => {
  it('记录 Stop 并只由下一真实 turn 清除', () => {
    notePromptPredictionSessionStopped('session-1');
    expect(wasPromptPredictionSessionStopped('session-1')).toBe(true);

    clearPromptPredictionSessionStopped('session-1');
    expect(wasPromptPredictionSessionStopped('session-1')).toBe(false);
  });

  it('INPUT_STOP 在 abort 前记账，中央 turn-start 边界负责清除', () => {
    const stopHandlerAt = REGISTER_SOURCE.indexOf('ipcMain.handle(MAKER_INVOKE.INPUT_STOP');
    const noteAt = REGISTER_SOURCE.indexOf('notePromptPredictionSessionStopped(sid);', stopHandlerAt);
    const abortAt = REGISTER_SOURCE.indexOf('inputCoordinator.stop(', stopHandlerAt);
    const clearAt = REGISTER_SOURCE.indexOf('clearPromptPredictionSessionStopped(session.id);');
    const turnStartAt = REGISTER_SOURCE.indexOf('markSessionTurnStarted(session.id);', clearAt);

    expect(stopHandlerAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeGreaterThan(stopHandlerAt);
    expect(noteAt).toBeLessThan(abortAt);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(turnStartAt);
  });
});
