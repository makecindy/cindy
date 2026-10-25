import {app} from 'electron';
import {createLogger} from '../logger.js';
import {MainProcessWorkdirProbeClient} from './MainProcessWorkdirProbeClient.js';
import {createWorkdirOperations} from '@cindy/worktree-core/workdirOperations';
export const workdirProbeHostClient=new MainProcessWorkdirProbeClient({log:createLogger('workdir-diagnostics')});
export const {statWorkingDirectory,mkdirWorkingDirectory,realpathWorkingDirectory,findSimilarWorkingDirectory}=createWorkdirOperations(workdirProbeHostClient);
if(typeof app.once==='function')app.once('before-quit',()=>workdirProbeHostClient.dispose());
