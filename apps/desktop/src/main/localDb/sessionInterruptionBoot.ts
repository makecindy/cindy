import {createSessionInterruptionBoot} from '@cindy/app-runtime/sessionInterruptionBoot';
export type * from '@cindy/app-runtime/sessionInterruptionBoot';

export const {getSessionInterruptionBootAt, setSessionInterruptionBootAtForTests}=createSessionInterruptionBoot();
