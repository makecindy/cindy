import path from 'node:path';
import { utilityProcess } from 'electron';
import { adaptPluginNodeProcess, pluginNodeEnvironment } from '../cindy-brain/nodeRuntimeProcessAdapter.js';
import { GHOST_NODE_CHILD_MODE_FLAG } from '../../shared/ghost.js';
import { adaptPreRunHookWorker } from './pre-run-hook-child.js';
import { configurePreRunNodeScriptSpawner } from './pre-run-hook.js';

/** Reuse the shipped utilityProcess bootstrap in raw child mode: no plugin APIs or broker
 * authorization are exposed. RunAsNode stays disabled. stdin remains a normal byte stream. */
configurePreRunNodeScriptSpawner((script, cwd) => {
  const child = utilityProcess.fork(path.join(__dirname, 'nodeRuntimeWorkerProcess.desktop.js'),
    [script, GHOST_NODE_CHILD_MODE_FLAG], { cwd, env: pluginNodeEnvironment('schedule-hook'),
      stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'cindy-schedule-hook' });
  // 事件/流收敛拆到 pre-run-hook-child.ts:那里不 import electron,单测可以直接驱动
  // 「exit 已到但 stdio 两流不发 end」这条真实边界(#11149)。
  return adaptPreRunHookWorker(adaptPluginNodeProcess(child, true));
});
