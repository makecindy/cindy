/**
 * DesktopCommandRegistry — main 进程持有的"desktop 自有 slash command"注册表。
 *
 * 与 maker-core 的 agent commands 并行: ChatInput palette 上看到的 / 命令来自三处:
 *   - desktop          (这里)            执行逻辑跑在 main, 永远不发给 agent
 *   - agent-builtin    (agent 子类硬编码) 由 desktop 拼成 prompt 前缀转发给 agent
 *   - agent-skill      (agent .md 扫描)   同上
 *
 * 注册表本身不知道 IPC / Electron, 只管"按名字找命令 + 调 execute"。
 * 上层 (maker-ipc/desktop-commands.ts) 负责把 list/execute 暴露成 IPC handler;
 * builtins 模块负责注册 /help /clear 这类内置项。
 *
 * 设计上不做"name 冲突 = 后注册者覆盖"——重复注册抛错, 强制开发期暴露;
 * 这是 main 进程内部约束, 没有"用户自定义命令覆盖 desktop 默认"的需求。
 */

import type { DesktopCommandMeta } from '@cindy/maker-core';

/**
 * 命令执行上下文 —— 调用方 (renderer 通过 IPC) 把当前会话信息透传过来,
 * 让 execute 知道 "在哪个 session / 哪个 cwd 触发的"。
 *
 * 字段刻意保留可选 —— 不是所有 desktop command 都关心 sessionId
 * (比如纯应用级的"打开 settings"); 关心的命令自己 narrow / 校验。
 */
export interface DesktopCommandContext {
  /** 触发命令时的 maker session id, 草稿态可为空字符串。 */
  sessionId?: string;
  /** 触发命令时的工作目录, 草稿态可为空字符串。 */
  workingDir?: string;
  /** 触发命令时跟在 `/name` 后面的剩余参数文本(去掉首个空格), 没有则空串。 */
  args?: string;
  /**
   * 发起命令的 renderer webContents id, 由 EXECUTE_DESKTOP_COMMAND IPC handler
   * 从 event.sender 填入(覆盖 renderer 传入的任何值,不可伪造)。需要"只回
   * 发起窗口"的命令(如 /issue 防多窗口重复 handleSend)用它做定向 send,
   * 缺失时回退广播。
   */
  senderWebContentsId?: number;
  /**
   * Main-owned lifecycle marker. A secondary-window command sets this only
   * after it has acquired the source session route lock and rechecked the
   * persisted session status. Renderer input with the same field is ignored.
   */
  sessionRouteLockHeld?: boolean;
  /**
   * device-link 远程会话的归属设备 id(renderer 从 remoteProjectsStore 注册表填入,
   * 本机会话缺省)。业务语义在"会话归属设备"的命令(/goal /learn /cmd)据此把
   * 执行经隧道路由到被控端;纯控制端 UI 命令(/help /clear 等)忽略它。
   * 不是安全边界 —— renderer 本就能经 preload deviceLink.invoke 直调 allowlist 内
   * channel,权威校验在被控端三道 gate(remoteControlEnabled + 撤销黑名单 + allowlist)。
   */
  deviceId?: string;
  /**
   * Secondary windows set this for a local task command. It asks the Main
   * process to reject dispatch when the task was archived after renderer-side
   * command reconciliation; it never grants access on its own.
   */
  requireActiveSession?: boolean;
}

/**
 * 完整的 desktop command 定义 —— execute 函数只在 main 进程持有,
 * 不通过 IPC 暴露给 renderer (函数无法序列化, 也没必要)。
 * 暴露给 renderer 的视图是 DesktopCommandMeta (kind/name/description), 见 list()。
 */
export interface DesktopCommandDefinition {
  name: string;
  description: string;
  /**
   * 主入口 —— 命中此命令时由 main 执行。
   * 同步/异步皆可; 抛错由调用方 catch + 上报, 不会自动 swallow。
   */
  execute(ctx: DesktopCommandContext): void | Promise<void>;
}

export class DesktopCommandRegistry {
  private readonly commands = new Map<string, DesktopCommandDefinition>();

  /** 注册一条命令; 重名抛错(开发期暴露问题, 不做静默覆盖)。 */
  register(cmd: DesktopCommandDefinition): void {
    if (this.commands.has(cmd.name)) {
      throw new Error(`DesktopCommandRegistry: duplicate command "/${cmd.name}"`);
    }
    this.commands.set(cmd.name, cmd);
  }

  /**
   * 暴露给 renderer 的视图: 只含 kind/name/description, 不含 execute 函数。
   * 与 maker-core 的 DesktopCommandMeta 形状一致, palette 直接消费。
   */
  list(): DesktopCommandMeta[] {
    return Array.from(this.commands.values()).map((c) => ({
      kind: 'desktop' as const,
      name: c.name,
      description: c.description,
    }));
  }

  /**
   * 按名字执行一条命令。
   * 找不到时抛错(由 IPC handler 翻译成 success:false 回 renderer); execute 自身的错由调用方处理。
   */
  async execute(name: string, ctx: DesktopCommandContext): Promise<void> {
    const cmd = this.commands.get(name);
    if (!cmd) {
      throw new Error(`DesktopCommandRegistry: unknown command "/${name}"`);
    }
    await cmd.execute(ctx);
  }
}
