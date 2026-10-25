import {createScheduledOutputProjection} from '@cindy/app-runtime/silent-output';
export type * from '@cindy/app-runtime/silent-output';
export const {setSilencedRunProbe,isSilencedSchedulerTurn,hidesScheduledTranscript,beginQuietScheduledOutput,isQuietScheduledOutput,projectQuietScheduledOutput}=createScheduledOutputProjection();
