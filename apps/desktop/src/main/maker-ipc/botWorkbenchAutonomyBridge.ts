import {createBotWorkbenchAutonomyBridge} from '@cindy/app-runtime/botWorkbenchAutonomyBridge';
export type {BotAutonomyReader} from '@cindy/app-runtime/botWorkbenchAutonomyBridge';
export const {registerBotAutonomyReader,readBotGlance,readSchedulerBotId,readWatchedSession}=createBotWorkbenchAutonomyBridge();
