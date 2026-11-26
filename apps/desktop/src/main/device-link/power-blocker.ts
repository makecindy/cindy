/**
 * power-blocker —— 「保持电脑唤醒」的 main 端 powerSaveBlocker 管理。
 *
 * 用 Electron 的 `powerSaveBlocker('prevent-app-suspension')`:
 *  - 阻止系统进入休眠 / 挂起 → 后台 agent(定时任务、远程会话)持续运行;
 *  - **允许**显示器熄屏 / 用户锁屏(不同于 'prevent-display-sleep',那个会强制常亮)。
 * 跨平台:Electron 底层在 macOS 走 IOPMAssertion、Windows 走 SetThreadExecutionState,
 * 两端语义一致(阻止 system sleep、放行 display sleep)。
 *
 * 每个 app 进程各自持有一个 blocker(不做跨实例仲裁):多实例共享 userData 时都读同一
 * 开关、各自 start,任一进程活着就能让机器不休眠,符合直觉。
 *
 * powerSaveBlocker 依赖注入(默认 electron 实现),便于单测无 Electron 环境下验证 start/stop 时序。
 */

import { powerSaveBlocker } from 'electron';

import { createLogger } from '../logger';

const log = createLogger('power-blocker');

/** powerSaveBlocker 后端接口(electron 同名 API 的子集),测试可注入替身。 */
export interface PowerSaveBlockerBackend {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/**
 * 「保持电脑唤醒」控制器:幂等地 start/stop 一个 prevent-app-suspension blocker。
 * 反复 apply(true) 只保留一个 blocker;apply(false) 释放。
 */
export class KeepAwakeController {
  private blockerId: number | null = null;
  /** 用户自己的「保持电脑唤醒」。 */
  private userEnabled = false;
  /**
   * 「用隐私屏代替锁屏」开着时电脑也不能休眠(AI 随时要用;见 privacy-screen.md),
   * 与用户自己的选择取并集;关掉隐私屏后恢复用户原来的选择。
   */
  private privacyScreen = false;

  constructor(private readonly backend: PowerSaveBlockerBackend = {
    start: (type) => powerSaveBlocker.start(type),
    stop: (id) => powerSaveBlocker.stop(id),
    isStarted: (id) => powerSaveBlocker.isStarted(id),
  }) {}

  /** 是否正持有生效中的 blocker。 */
  get active(): boolean {
    return this.blockerId !== null && this.backend.isStarted(this.blockerId);
  }

  /** 用户的「保持电脑唤醒」开关;幂等。 */
  apply(enabled: boolean): void {
    this.userEnabled = enabled;
    this.sync();
  }

  /** 「用隐私屏代替锁屏」是否开着;幂等。 */
  setPrivacyScreen(enabled: boolean): void {
    this.privacyScreen = enabled;
    this.sync();
  }

  private sync(): void {
    const enabled = this.userEnabled || this.privacyScreen;
    if (enabled) {
      if (this.active) return; // 已在生效,免重复 start
      this.blockerId = this.backend.start('prevent-app-suspension');
      log.info('keep-awake started', { id: this.blockerId });
    } else {
      if (this.blockerId === null) return;
      const id = this.blockerId;
      this.blockerId = null;
      if (this.backend.isStarted(id)) {
        this.backend.stop(id);
        log.info('keep-awake stopped', { id });
      } else {
        // blocker 已被外部(如系统 / 另一进程)停止,这里只清引用,不重复 stop。
        log.info('keep-awake released (already stopped)', { id });
      }
    }
  }
}

/** 进程级单例。 */
export const keepAwakeController = new KeepAwakeController();
