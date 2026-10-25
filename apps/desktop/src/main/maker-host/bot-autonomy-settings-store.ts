import {app} from 'electron';
import {activeOwnerScopeKey,getActiveAppSession,ownerScopedUserDataPath} from '../appSessionState.js';
import {desktopMakerLogger} from './logger-adapter.js';
import {createBotAutonomySettings} from '@cindy/app-runtime/botAutonomySettings';
export type {BotAutonomySettingsOverride} from '@cindy/app-runtime/botAutonomySettings';
export const {readBotAutonomySettingsOverride,writeBotAutonomySchedulerBotId,resetBotAutonomySettings}=createBotAutonomySettings({
 activeOwnerScopeKey,getActiveAppSession,ownerScopedUserDataPath,legacyUserDataPath:()=>app.getPath('userData'),log:desktopMakerLogger.child('bot-autonomy-settings-store'),
});
