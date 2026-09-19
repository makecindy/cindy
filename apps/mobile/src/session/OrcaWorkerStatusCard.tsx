import { useCallback, useEffect, useReducer, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme, type ThemeColors } from '@/theme';
import { i18n } from '@/i18n';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { hasDeviceLinkErrorCode } from '@/device-link/rehydrate';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, typeScale } from '@/theme/tokens';

type Worker = { id?: string; label?: string; role?: string; status?: string; sessionId?: string };

const workerStatusKeys = new Set(['running', 'idle', 'done', 'error', 'archived']);

function statusLabel(status: string | undefined): string {
  const key = status && workerStatusKeys.has(status) ? status : 'unknown';
  return i18n.t(`session.presentation.collaboration.workerStatus.${key}`);
}

/**
 * 状态点语义色,对齐移动端既有约定(InteractionPanel:1907「已完成 statusReady /
 * 进行中 statusAccent / 其余 textTertiary」):statusAccent 专指运行/思考中,
 * idle、archived 与未知状态一律走中性色,不能和运行中撞色。
 */
function statusDotColor(status: string | undefined, colors: ThemeColors): string {
  if (status === 'error') return colors.statusError;
  if (status === 'done') return colors.statusDone;
  if (status === 'running') return colors.statusAccent;
  return colors.textTertiary;
}

const attentionStatuses = new Set(['done', 'error']);

function workerKey(worker: Worker, index: number): string {
  return worker.id ?? worker.sessionId ?? String(index);
}

/**
 * 进程级 edge-trigger attention store,对齐
 * docs/dev-rules/orca-team-architecture.md:324 的不变量:
 * 「worker 状态跳变进 done 才标 attention;正在查看该 worker 时清除;
 *  只切走 / 切回不应让同一轮 done 重新变未读」。
 *
 * 因此未读不能是组件局部 state —— 切 Lead、离开会话页再回来都不得重置。
 * lastStatus 用于边沿判定:done → running → done 属于两次跳变,第二次必须
 * 重新标记;而同一轮 done 期间的反复切换不产生新边沿。
 * 以 module 作用域承载 = 桌面 workerAttentionStore 在手机端的等价物。
 */
// value = 触发未读的那个终态。不能只存 key:worker 从 error 转回 running/idle 后
// 未读仍然成立(结果还没被看过),但若此时按**当前**状态推断提示色,会把一次 error
// 显示成绿色 Done。记下产生未读的状态,提示语义才跟着来源走。
const unreadWorkers = new Map<string, string>();
const lastWorkerStatus = new Map<string, string>();

function attentionKey(leadSessionId: string, key: string): string {
  return `${leadSessionId}::${key}`;
}

/** 按新快照推进边沿判定。返回未读集合是否变化,供调用方决定是否重渲染。 */
function applyWorkerAttentionEdges(leadSessionId: string, workers: Worker[]): boolean {
  let changed = false;
  workers.forEach((worker, index) => {
    const key = attentionKey(leadSessionId, workerKey(worker, index));
    const status = worker.status ?? 'unknown';
    const previous = lastWorkerStatus.get(key);
    lastWorkerStatus.set(key, status);
    if (previous === status) return;
    // 跳变进终态才标未读;离开终态自然不再是未读来源。
    if (attentionStatuses.has(status) && !unreadWorkers.has(key)) {
      unreadWorkers.set(key, status);
      changed = true;
    }
  });
  return changed;
}

/**
 * 老被控端没有这条 channel,会稳定返回 CHANNEL_NOT_ALLOWED。这是**永久性**的兼容
 * 结果而非瞬时失败:重试多少次都一样,再轮询下去只是白耗 device-link 与电量。
 * 命中即停轮询,面板保持不显示 —— 这正是 deviceLinkContract 里写的降级语义。
 */
function isUnsupportedChannelError(error: unknown): boolean {
  return hasDeviceLinkErrorCode(error, 'CHANNEL_NOT_ALLOWED')
    || hasDeviceLinkErrorCode(error, 'DEVICE_LINK_CHANNEL_NOT_ALLOWED');
}

function workersFrom(value: unknown): Worker[] {
  if (Array.isArray(value)) return value.filter((v): v is Worker => !!v && typeof v === 'object');
  if (value && typeof value === 'object' && Array.isArray((value as { workers?: unknown }).workers)) {
    return workersFrom((value as { workers: unknown }).workers);
  }
  return [];
}

export function OrcaWorkerStatusCard({ leadSessionId, deviceId, maker, onOpenWorker }: {
  leadSessionId: string;
  /** 被控设备 id;用于跟踪该 peer 的在线代次(见下方 unsupported 复位)。 */
  deviceId: string;
  maker: MobileMakerTransport;
  /**
   * 打开该 Worker 的会话;只读口径由 collaboration.ts 按 orcaRole 判定。
   * 返回 false 表示导航被丢弃(失焦 / 前进锁),此时不得把该 Worker 记为已查看。
   */
  onOpenWorker?: (workerSessionId: string) => boolean;
}) {
  const { colors } = useTheme();
  // 快照与它所属的 Lead 绑定,渲染期同步比对。抽屉就地换 Lead 时组件不卸载,若只靠
  // effect 事后清空,B 的首帧会先闪一遍 A 的 Worker 列表。
  const [snapshot, setSnapshot] = useState<{ lead: string; workers: Worker[] } | null>(null);
  const workers = snapshot?.lead === leadSessionId ? snapshot.workers : null;
  // 对齐桌面右侧栏「协同」tab:默认不展开,靠 attention 点把用户拉回来。
  // 桌面关闭 tab ≡ 结束协同(disableOrca);手机版第一版只读,这里只是视图折叠。
  const [expanded, setExpanded] = useState(false);
  // 轮询门控与本屏既有写法同构([sessionId]:965-1010):focus 与 AppState 正交 ——
  // 推入文件浏览器等路由后本屏仍挂载(见 [sessionId]:3796-3798),不门控会在看不见
  // 的屏幕上持续发远端库读;后台时导航也可能仍是 focused,必须各自判定。
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setAppActive(next === 'active'));
    return () => subscription.remove();
  }, []);
  // 未读只存在于 module 级 store(见上),这里只用一个计数器触发重渲染。
  const [, bumpAttention] = useReducer((value: number) => value + 1, 0);
  // 换 Lead 时收起列表。快照不在此处清 —— 它由上面的 lead 比对同步失效,不依赖
  // effect 事后补刀。未读同样**不**重置:契约要求切走 / 切回不得让同一轮 done
  // 重新变未读。
  useEffect(() => {
    setExpanded(false);
  }, [leadSessionId]);
  // 被控端不支持该 channel 的判定。复位依赖要覆盖「被控端换了个实例」的全部路径:
  //  - maker:transport 身份变化(换设备/换会话树)。
  //  - connectionEpoch:本机 controller 重连 relay(整代作废)。
  //  - peerAvailable:**目标 peer 自身**的在线代次 —— 被控端升级/重启时通常只有它
  //    自己断连重连,connectionEpoch 不动,光靠它会让 unsupported 永久为真。
  //    getPresenceAvailability 是「当前 relay 连接代内的逐设备 availability」,
  //    peer 掉线再上线必然翻转,正是所需的 peer 代次。
  // 失焦再聚焦不在其中:那不产生新的连接代,不该重探。
  const { status, connectionEpoch, getPresenceAvailability } = useDeviceLink();
  // 可达 = relay 在线 **且** 该 peer 未被判定离线。两者缺一不可:
  //  - 逐设备 availability 是「上一代内」的结论,relay 掉线后它可能仍停在 true,
  //    只看它会继续发请求,每轮在 ensureOnlineForRequest 上白等再失败。
  //  - 只看 relay 又会漏掉「relay 在线但目标被控端离线」。
  // 与本屏既有写法同构([sessionId] 的 remoteHistoryAvailable 也是两者并用)。
  // availability 的 null = 本代尚无权威 verdict,不是离线:只把确定的 false 当不可达,
  // 否则 verdict 迟迟不来会把面板永久关掉。
  const relayOnline = status === 'online';
  const peerReachable = relayOnline && getPresenceAvailability(deviceId) !== false;
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    // peer 确定离线时不复位:此刻重探只会立刻撞 DEVICE_OFFLINE。等它回来再说。
    if (!peerReachable) return;
    setUnsupported(false);
  }, [leadSessionId, maker, connectionEpoch, peerReachable]);
  // peer 确定离线时暂停轮询:DeviceLinkContext.invoke 会立刻抛 DEVICE_OFFLINE,
  // 每 5 秒撞一次既无意义又耗电。peer 回来后由上面的复位 effect 重新起轮。
  const polling = focused && appActive && !unsupported && peerReachable;
  useEffect(() => {
    if (!polling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      // stop 不能用 return 代替:finally 照样会执行,只有标志能拦住下一轮排程。
      let stop = false;
      try {
        const next = workersFrom(await maker.listOrcaWorkersByLead(leadSessionId));
        if (active) {
          applyWorkerAttentionEdges(leadSessionId, next);
          setSnapshot({ lead: leadSessionId, workers: next });
        }
      } catch (error) {
        if (isUnsupportedChannelError(error)) {
          // 永久性兼容结果,重试无意义:停轮询。同时丢弃旧快照 —— 设备被旧版实例
          // 接管/回滚时,留着它会无限期展示已无法验证的 Worker 状态,与「面板保持
          // 不显示」的降级语义矛盾。
          stop = true;
          if (active) {
            setUnsupported(true);
            setSnapshot(null);
          }
        }
        // 其余为瞬时失败:保留上一份快照,下一轮再刷。
      } finally {
        if (active && !stop) timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [leadSessionId, maker, polling]);
  // 拿到非空快照前不占位:本卡在 sessionChrome 里,其 onLayout 高度是消息列表的
  // 顶部内距,先撑开再收起会让会话内容跳动。
  if (!workers?.length) return null;
  const title = i18n.t('session.presentation.collaboration.workersTitle', { n: workers.length });
  // 与桌面 useOrcaWorkerAttentionWatcher:44-49 一致:done 在被查看前同样算未读;
  // 查看过就不再提示,直到该 Worker 的状态再次变动。
  // 取未读**产生时**的状态,而不是 worker 的当前状态。
  const pendingStatuses = workers
    .map((worker, index) => unreadWorkers.get(attentionKey(leadSessionId, workerKey(worker, index))))
    .filter((status): status is string => status !== undefined);
  const needsAttention = pendingStatuses.length > 0;
  const attentionStatus = pendingStatuses.includes('error') ? 'error' : 'done';
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return <View style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={needsAttention ? `${title} · ${statusLabel(attentionStatus)}` : title}
      onPress={() => setExpanded((value) => !value)}
      style={styles.header}
      testID="session.orcaWorkers.toggle"
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
      {!expanded && needsAttention
        ? <View style={[styles.attentionDot, { backgroundColor: statusDotColor(attentionStatus, colors) }]} testID="session.orcaWorkers.attention" />
        : null}
      <Chevron accessible={false} color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
    </Pressable>
    {/* 桌面 Worker 上限为 20(register.ts COLLABORATION_WORKER_LIMIT_MAX),按 44pt 行高
        展开后可达 880pt,会把消息视口挤没。这里限高滚动,卡片高度恒定可控。 */}
    {expanded ? <ScrollView style={styles.rows} nestedScrollEnabled>{workers.map((worker, index) => {
      // 兜底名同样走 catalog:GLOSSARY:58 裁决的是「Worker 五语保留英文」这一译法,
      // 不是「可以不进词条」—— 硬编码会绕过 i18n 门禁与未来的排版调整。
      const name = worker.label ?? worker.role
        ?? i18n.t('session.presentation.collaboration.workerFallbackName', { n: index + 1 });
      const workerSessionId = worker.sessionId;
      const body = <>
        <View style={[styles.dot, { backgroundColor: statusDotColor(worker.status, colors) }]} />
        <Text numberOfLines={1} style={[styles.name, { color: colors.textPrimary }]}>{name}</Text>
        <Text style={[styles.status, { color: colors.textSecondary }]}>{statusLabel(worker.status)}</Text>
      </>;
      const key = workerKey(worker, index);
      // 没有 sessionId 的 Worker 无处可跳,保持静态行,不做假的可点外观。
      return onOpenWorker && workerSessionId
        ? <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`${name} · ${statusLabel(worker.status)}`}
            onPress={() => {
              // 先看导航是否真的受理:guardedPush 在失焦 / 前进锁命中时静默丢弃。
              // 只有真打开了才算「正在查看」,否则该 Worker 会被误标已读。
              if (!onOpenWorker(workerSessionId)) return;
              if (unreadWorkers.delete(attentionKey(leadSessionId, key))) bumpAttention();
            }}
            style={({ pressed }) => [styles.row, styles.rowPressable, pressed && { opacity: 0.6 }]}
            testID={`session.orcaWorkers.worker.${workerSessionId}`}
          >
            {body}
            <ChevronRight accessible={false} color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </Pressable>
        : <View key={key} style={styles.row}>{body}</View>;
    })}</ScrollView> : null}
  </View>;
}

const styles = StyleSheet.create({ card: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container }, header: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44 }, title: { flex: 1, fontSize: typeScale.body, fontWeight: fontWeight.semibold }, attentionDot: { width: 6, height: 6, borderRadius: radius.micro }, rows: { maxHeight: 264 }, row: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: lineHeight.listBody }, rowPressable: { minHeight: 44 }, dot: { width: iconSize.sm, height: iconSize.sm, borderRadius: radius.micro }, name: { flex: 1, fontSize: typeScale.body }, status: { fontSize: typeScale.caption } });
