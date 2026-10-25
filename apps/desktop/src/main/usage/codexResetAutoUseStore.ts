import path from 'node:path';
import {activeOwnerScopeKey,ownerScopedUserDataPath} from '../appSessionState.js';
import {desktopMakerLogger} from '../maker-host/logger-adapter.js';
import {createCodexResetAutoUseStore as createStore} from '@cindy/app-runtime/codexResetAutoUseStore';
export {codexResetAccountKey} from '@cindy/app-runtime/codexResetAutoUseStore';
export const createCodexResetAutoUseStore=(filePath:()=>string,scopeKey=activeOwnerScopeKey)=>createStore(filePath,scopeKey,desktopMakerLogger.child('codex-reset-auto-use'));
export const codexResetAutoUseStore=createCodexResetAutoUseStore(()=>path.join(ownerScopedUserDataPath(),'codex-reset-auto-use.json'));
