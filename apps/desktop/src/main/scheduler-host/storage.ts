import {createScheduleStorage} from '@cindy/app-runtime/scheduleStorage';
import * as mapper from '../localDb/mapper';
import * as money from '../../shared/regionalMoney.js';
import {broadcastSessionPatched} from '../localDb/ipc/sessions.js';
export type * from '@cindy/app-runtime/scheduleStorage';
export const {DrizzleScheduleStorage}=createScheduleStorage({...mapper,money,broadcastSessionPatched:(...args)=>broadcastSessionPatched(...args)});
export type DrizzleScheduleStorage=InstanceType<typeof DrizzleScheduleStorage>;
