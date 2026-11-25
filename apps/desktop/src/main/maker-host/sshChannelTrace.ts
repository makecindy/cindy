/**
 * SSH 通道的匿名标识 —— 把客户端日志里的「通道开 / 关」和远端进程对上。
 *
 * 背景(#12571):现场看到同一条 SSH 连接下挂着多条 `cc-mgr.mjs bridge` /
 * `codex app-server proxy`,但客户端日志里没有通道级的开闭记录,没法回答
 * 「谁持有这条通道、什么时候释放」。每条通道发一个随机 id:
 *
 *   - 本地:开 / 关各记一条日志,包含 id、host、用途及通道生命周期信息;
 *   - 远端:同一个 id 通过远端 shell 的环境变量传给通道进程,远端可用
 *     `tr '\0' '\n' < /proc/<pid>/environ` 把它和具体 PID 对上。
 *
 * 标识本身只含随机十六进制 —— 不编码 host / session / 路径 / 消息正文,
 * 也不新增任何 wire 字段或远端协议参数:远端老版本 bundle 忽略这个环境
 * 变量,行为完全不变。
 */

import { randomBytes } from 'node:crypto';

/** 传给远端通道进程的环境变量名。 */
export const SSH_CHANNEL_TRACE_ENV = 'CINDY_SSH_CHANNEL_ID';

/** 12 位随机十六进制,便于在日志和进程环境中配对。 */
export function newSshChannelTraceId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 远端 shell 里给通道进程带上标识的赋值片段。
 *
 * 用 `export VAR=...;` 而不是 `VAR=... cmd` 前缀语法: 前者在 POSIX sh /
 * bash / zsh 下语义一致, 也不依赖 coreutils 的 `env` —— 远端可能是极简镜像,
 * 而 cc-mgr 的其它步骤已经只用 `bash -c` 跑过(见 ensureDaemonRunning),
 * 没有引入新的远端依赖。
 *
 * 只接受随机十六进制 —— 标识会拼进远端 shell 命令行,不能带任何 shell 元字符。
 */
export function sshChannelTraceExport(id: string): string {
  if (!/^[0-9a-f]{8,32}$/.test(id)) {
    throw new Error(`sshChannelTraceExport: unexpected trace id ${JSON.stringify(id)}`);
  }
  return `export ${SSH_CHANNEL_TRACE_ENV}=${id};`;
}

/**
 * 给一条远端 shell 命令带上通道标识(前缀 export)。exec/execStream 的命令最终由
 * 远端 sshd 用登录 shell `-c` 执行,export 的变量会被命令本身及其子进程继承
 * (含 `bash -c` 包一层的 codex 包装)。
 *
 * 不用 ssh2 exec 的 `env` 选项:服务端默认不接受客户端环境变量(AcceptEnv
 * 白名单),前缀写法不依赖 sshd 配置。
 */
export function withSshChannelTrace(cmd: string, id: string): string {
  return `${sshChannelTraceExport(id)} ${cmd}`;
}
