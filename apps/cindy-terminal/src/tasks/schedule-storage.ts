import {createScheduleStorage} from '@cindy/app-runtime/scheduleStorage';
import type {TerminalTaskHost} from './host.js';
export type TerminalScheduleStorage=InstanceType<ReturnType<typeof createScheduleStorage>['DrizzleScheduleStorage']>;
/** Schedules and execution history use the same owner SQLite store as Desktop. */
export async function openTerminalScheduleStorage(tasks:TerminalTaskHost):Promise<TerminalScheduleStorage>{
 await tasks.ready;
 const [database,conversations]=await Promise.all([tasks.database,tasks.conversations]);
 const {DrizzleScheduleStorage}=createScheduleStorage({...conversations.rowMapper,money:conversations.money,...conversations.notifications});
 return new DrizzleScheduleStorage(()=>database.getDbClient().drizzle);
}
