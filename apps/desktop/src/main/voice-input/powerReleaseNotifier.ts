/**
 * 系统电源事件 → 释放语音输入保活麦克风(main 侧广播)。
 *
 * fast activation 会让麦克风在用完后继续待命一段时间(renderer 侧
 * WebMicAudioEngine 的 keep-alive session)。系统挂起或锁屏意味着用户已经离开:
 * 这时继续占着采集设备既拿不到延迟收益,又让系统隐私指示灯常亮,并通过
 * coreaudiod 持有 idle-sleep assertion,把整机拖在不睡眠的状态。
 *
 * 这里只广播事实,不做决策——哪个窗口真的持有 keep-alive session 只有 renderer
 * 知道,main 无从判断,也不应该替它判断。
 *
 * 与 powerWakeDiagnostics 分开:那个模块的契约是「只记日志,不改任何行为」,
 * 在它里面挂副作用会破坏该承诺。依赖以注入面暴露,单测不需要 Electron。
 */
import {
  VOICE_INPUT_POWER_STATE_CHANNEL,
  type VoiceInputPowerReleaseReason,
  type VoiceInputPowerStatePayload,
} from '../../shared/voiceInputPowerIpc';
import { createLogger } from '../logger';

const log = createLogger('voice-input-power');

/** powerMonitor 注入面(单测用假 emitter)。 */
export interface VoicePowerMonitorLike {
  on(event: 'suspend' | 'lock-screen', listener: () => void): unknown;
}

export interface VoiceInputPowerReleaseDeps {
  powerMonitor: VoicePowerMonitorLike;
  /** 把 payload 送到所有 renderer;注入以便单测断言广播内容。 */
  broadcast: (channel: string, payload: VoiceInputPowerStatePayload) => void;
  logger?: Pick<typeof log, 'debug'>;
}

/**
 * 订阅挂起/锁屏并广播释放信号。
 *
 * macOS 与 Windows 都会触发 suspend;lock-screen 两端语义不同(macOS 为锁屏,
 * Windows 为工作站锁定),但「用户已离开」的判断在两端一致,因此同样处理。
 * Linux 不触发 lock-screen,不影响 suspend 路径。
 */
/** 广播目标窗口的最小结构面(用结构类型,避免这里依赖 Electron)。 */
export interface VoicePowerBroadcastWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/**
 * 逐窗发送,单窗失败不影响其余窗口。
 *
 * 窗口可能在 isDestroyed() 与 send() 之间被销毁而抛错。这是一次性事件:循环一旦
 * 中断,后面的窗口(可能正是持有麦克风的那个)就永远收不到释放信号,只能等 idle
 * 超时。容错写法与 appBadgeService 的广播保持一致。
 */
export function broadcastVoiceInputPowerState(
  windows: readonly VoicePowerBroadcastWindow[],
  channel: string,
  payload: VoiceInputPowerStatePayload,
  logger?: Pick<typeof log, 'warn'>,
): void {
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      (logger ?? log).warn('broadcast voice input power release failed:', err);
    }
  }
}

export function installVoiceInputPowerRelease(deps: VoiceInputPowerReleaseDeps): void {
  const logger = deps.logger ?? log;
  const emit = (reason: VoiceInputPowerReleaseReason): void => {
    logger.debug('voice input keep-alive release broadcast', { reason });
    deps.broadcast(VOICE_INPUT_POWER_STATE_CHANNEL, { reason });
  };

  deps.powerMonitor.on('suspend', () => emit('system_suspend'));
  deps.powerMonitor.on('lock-screen', () => emit('screen_locked'));
}
