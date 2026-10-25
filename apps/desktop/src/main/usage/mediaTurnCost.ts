import { createMediaTurnCost } from '@cindy/app-runtime/media/mediaTurnCost';
import {readPriorUserRoundCost} from '../localDb/ipc/messages.js';
import * as money from '../../shared/regionalMoney.js';
export const {captureMediaUserTurn,refreshMediaUserTurnCost}=createMediaTurnCost({...money,readPriorUserRoundCost});
