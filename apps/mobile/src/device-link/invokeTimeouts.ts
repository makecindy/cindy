import { INVOKE_TIMEOUT_OVERRIDES_MS } from '@cindy/device-link';

/**
 * mobile 侧 invoke 超时解析(优先级:mobile 精确表 → schedule 前缀规则 →
 * 协议契约表 → undefined = client 默认 15s)。
 *
 * 背景:mobile 把默认请求超时从 30s 收紧到 15s 后,凡是桌面端有更长执行预算的
 * 通道都必须在这里保住原有窗口,否则合法慢操作会被提前掐断(review 三轮反馈):
 *  - media:fetch:桌面拉文件传 OSS,最大 2GB;
 *  - file-browser:remote-op:searchCollect 桌面执行预算 20s(SEARCH_COLLECT_TIMEOUT_MS);
 *  - maker:schedule:*:桌面 handler 会等 scheduler 就绪(READINESS_TIMEOUT_MS=30s,
 *    冷启动 / 登出登录窗口内就绪可能落在 15-30s),40s = 就绪上限 + 执行余量;
 *  - voice:dictionary-learning:桌面 advisor 走 managed refiner,单次尝试空闲窗
 *    12s(VOICE_INPUT_MANAGED_REFINER_IDLE_TIMEOUT_MS)且主模型卡住会换备选
 *    profile 再试,合法执行可超 15s;误超时会让后台学习白白计入熔断失败;
 *  - voice:transcribe:桌面端先 downloadToBuffer 从 OSS 拉音频再走批量网关转写,
 *    两段都无更短的执行 deadline,中速/慢网络下合法执行可超 15s,且连续几条
 *    语音误超时就会错误打开设备级熔断;
 *  - maker:fork:桌面端 forkSessionAtMessage 载入完整可见消息前缀 + SDK fork +
 *    事务内批量拷贝,大会话可落在 15-30s;且该操作**非幂等**——误超时后桌面端
 *    仍会建出并广播新会话,用户重试会分叉出重复副本;
 *  - maker:rewind:commit:transcript/DB 读 + SDK/Codex 线程回滚 + Git 文件回退 +
 *    收尾 SQLite 事务,同样非幂等——误超时后对话与文件已被回退,重试会作用在
 *    已变更的历史上。
 * 新增合法慢通道优先登记协议契约表(桌面控制端共用),仅 mobile 特有差异放这里。
 */
export const MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  'device-link:media:fetch': 30_000,
  'device-link:voice:dictionary-learning': 30_000,
  'device-link:voice:transcribe': 30_000,
  'file-browser:remote-op': 30_000,
  'maker:fork': 30_000,
  'maker:rewind:commit': 30_000,
};

export const MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS = 40_000;

export function resolveMobileInvokeTimeoutMs(channel: string): number | undefined {
  const exact = MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS[channel];
  if (exact !== undefined) return exact;
  if (channel.startsWith('maker:schedule:')) return MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS;
  return INVOKE_TIMEOUT_OVERRIDES_MS[channel];
}
