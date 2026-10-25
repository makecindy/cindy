import { createSessionTerminalReader } from '@cindy/runtime-db/sessionTerminal';
import { getDbClient } from './client/current';
export type * from '@cindy/runtime-db/sessionTerminal';
export const { readLatestSessionTerminal } = createSessionTerminalReader(() => getDbClient());
