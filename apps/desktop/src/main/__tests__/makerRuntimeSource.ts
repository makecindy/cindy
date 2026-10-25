import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readSharedRuntimeSource(name: string): string {
  return readFileSync(resolve(__dirname, '../../../../../packages/app-runtime/src', name + '.ts'), 'utf8')
    .replace(/\r\n?/g, '\n');
}

/** Preserve the existing cross-stage contract guards after extraction. Both the
 * real Desktop binding and the real service must exist; no fixture body is used. */
export function readMakerRegisterSource(): string {
  let source = readFileSync(resolve(__dirname, '../maker-ipc/register.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const axisStart = source.indexOf('  registerSessionRuntimeAxisHandlers(ipcMain, {');
  const axisEnd = source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_PERMISSION_MODE,', axisStart);
  const axisService = readSharedRuntimeSource('sessionRuntimeAxisHandlers');
  const helpersStart = axisService.indexOf('  const recoverRemoteRuntimeAxisPersistence = async (');
  const fastStart = axisService.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_FAST_MODE,');
  if (axisStart < 0 || axisEnd < axisStart || helpersStart < 0 || fastStart < helpersStart)
    throw new Error('Original runtime axis service is not wired into Desktop');
  const normalizeAxes = (value: string) => value.replaceAll('host.pendingCredentialSwitchHolder', 'pendingCredentialSwitchHolder')
    .replaceAll('markRemoteSettingPersistedInsideHandler?.', 'markRemoteSettingPersistedInsideHandler');
  source = source.slice(0, axisStart) + normalizeAxes(axisService.slice(helpersStart, fastStart)) + source.slice(axisEnd);
  const fastInsertion = source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_THINKING_ENABLED,');
  if (fastInsertion < 0) throw new Error('Original Fast mode handler order is unavailable');
  source = source.slice(0, fastInsertion) + normalizeAxes(axisService.slice(fastStart, axisService.lastIndexOf('}')))
    + source.slice(fastInsertion);
  const bindingStart = source.indexOf('  const handleSetModel = createSessionModelSelection({');
  const bindingEnd = source.indexOf('\n  applyPiModelSettingsRefresh = ', bindingStart);
  const service = readSharedRuntimeSource('sessionModelSelection');
  const bodyStart = service.indexOf('const handleSetModel = async (');
  const bodyEnd = service.indexOf('\nreturn handleSetModel;', bodyStart);
  if (bindingStart < 0 || bindingEnd < bindingStart || bodyStart < 0 || bodyEnd < bodyStart) {
    throw new Error('Original model selection service is not wired into Desktop');
  }
  const body = service.slice(bodyStart, bodyEnd)
    .replaceAll('host.pendingCredentialSwitchHolder', 'pendingCredentialSwitchHolder')
    .replaceAll('host.contextOverflowRolloverHolder', 'contextOverflowRolloverHolder')
    // Desktop always supplies this marker; Node has no legacy persistence tail.
    .replaceAll('markRemoteSettingPersistedInsideHandler?.', 'markRemoteSettingPersistedInsideHandler');
  const combined = source.slice(0, bindingStart) + '  ' + body + source.slice(bindingEnd);
  const fallbackStart = combined.indexOf('  const maybeApplySessionRuntimeFallback = createSessionRuntimeFallback({');
  const fallbackEnd = combined.indexOf('  const sessionControlService = createSessionControlService({', fallbackStart);
  const fallbackService = readSharedRuntimeSource('sessionRuntimeFallback');
  const fallbackBodyStart = fallbackService.indexOf('const maybeApplySessionRuntimeFallback = async (');
  const fallbackBodyEnd = fallbackService.indexOf('return maybeApplySessionRuntimeFallback;', fallbackBodyStart);
  if (fallbackStart < 0 || fallbackEnd < fallbackStart || fallbackBodyStart < 0 || fallbackBodyEnd < fallbackBodyStart)
    throw new Error('Original runtime fallback service is not wired into Desktop');
  return combined.slice(0, fallbackStart) + '  ' + fallbackService.slice(fallbackBodyStart, fallbackBodyEnd)
    + combined.slice(fallbackEnd);

}
