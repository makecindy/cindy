/**
 * remoteCmdIpc —— `/cmd` 的被控端远程执行边界(desktop-cmd:run)。
 *
 * 远程会话的 /cmd 语义主体是「会话归属的那台设备」:控制端 builtins 在 ctx 带
 * deviceId 时把 { cmdLine, cwd } 隧道到这里,由被控端在会话 workingDir 下执行,
 * 结果(CmdExecutionResult)原样回传、控制端照常渲染 /cmd 卡。
 *
 * 安全:
 *  - channel 在 REMOTE_INVOKE_ALLOWLIST(default-deny)且经被控端三道 gate
 *    (remoteControlEnabled + 撤销黑名单 + allowlist)后才会 dispatch 到这里;
 *  - cwd 过 remote-workdir-guard 实时探测,挡掉不可访问 / 不存在路径 /
 *    文件冒充目录;越权论证同 fs:list-dir——同账号 + 显式 opt-in
 *    下控制端本就能驱动 agent 执行任意命令,不扩大攻击面;
 *  - 执行体复用 builtins 的 runShellCommand(30s 超时 / 64KB 截断 / 编码兜底),
 *    本机与远程 /cmd 行为一致。
 *
 * 本 handler 仅供隧道 dispatch(经 invoke-registry 捕获);本机 /cmd 不走这里
 * (builtins execute 内联执行,免一次 IPC 往返)。
 */

import { ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { throwIpcError, requireString, requireObject } from '../utils/ipcValidate.js';
import { isRemoteWorkingDirAllowed } from '../device-link/remote-workdir-guard.js';
import { runShellCommand, type CmdExecutionResult } from './builtins.js';

const log = createLogger('desktop-commands:remote-cmd');

/** desktop-cmd:run channel 常量(allowlist / 控制端 builtins 同名字符串消费)。 */
export const DESKTOP_CMD_RUN_CHANNEL = 'desktop-cmd:run';

/** 幂等保护:与 registerLearnIpc 同款 —— 可重试注册块内二次执行不 throw。 */
let _registered = false;

export function registerRemoteCmdIpc(): void {
  if (_registered) return;
  _registered = true;
  ipcMain.handle(
    DESKTOP_CMD_RUN_CHANNEL,
    async (_event, input: unknown): Promise<CmdExecutionResult> => {
      const obj = requireObject(input, 'input');
      const cmdLine = requireString(obj.cmdLine, 'cmdLine').trim();
      const cwd = requireString(obj.cwd, 'cwd');
      if (!cmdLine) throwIpcError('INVALID_PARAMS', 'cmdLine must not be empty');
      if (!(await isRemoteWorkingDirAllowed(cwd))) {
        throwIpcError('INVALID_PARAMS', `working directory not allowed: ${cwd}`);
      }
      log.info('remote /cmd exec ▶', { cmdLine, cwd });
      const result = await runShellCommand({ cmdLine, cwd });
      log.info('remote /cmd exec ◀', {
        cmdLine,
        cwd,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        timedOut: result.timedOut,
        spawnError: result.spawnError ?? null,
      });
      return result;
    },
  );
  log.info('remote cmd IPC handler registered');
}
