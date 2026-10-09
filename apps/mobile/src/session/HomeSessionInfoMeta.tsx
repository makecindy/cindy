import { createContext, Fragment, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import { PR_STATUS_REFRESH_INTERVAL_MS } from '@cindy/maker-shared';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { iconSize, iconStroke, spacing } from '@/theme/tokens';
import { useMinuteNow } from '@/utils/useMinuteNow';
import {
  buildHomeSessionInfoPieces,
  DEFAULT_HOME_TASK_INFO_FIELDS,
  type HomeListViewMode,
  type HomeTaskInfoField,
} from './homeDisplaySettings';
import {
  homeSessionPrCacheKey,
  loadHomeSessionPr,
  readHomeSessionPr,
  refreshHomeSessionPr,
  subscribeHomeSessionPr,
  type HomeSessionPrInfo,
} from './homeSessionPrStore';
import { prStatusVisual } from './prStatusVisual';
import { useRemoteSessionStoreVisibility, useRemoteSessionUsage, type RemoteSessionUsage } from './remoteSessionStore';
import { formatRemoteSessionSidebarTime, type RemoteSessionListItem } from './sessionList';

/**
 * 首页任务行的显示设置(显示形态 + 任务信息)。行组件已 memo 化,经 context 下发,
 * 切换设置时只有任务行重渲染,不必改动列表数据。默认值 = 手机首页原来的样子
 * (列表形态 + 只显示时间),其它复用任务行的页面不提供 Provider 时保持原样。
 */
export interface HomeRowDisplay {
  viewMode: HomeListViewMode;
  taskInfoFields: readonly HomeTaskInfoField[];
}

export const HomeRowDisplayContext = createContext<HomeRowDisplay>({
  taskInfoFields: DEFAULT_HOME_TASK_INFO_FIELDS,
  viewMode: 'list',
});

export function useHomeRowDisplay(): HomeRowDisplay {
  return useContext(HomeRowDisplayContext);
}

/**
 * 行右侧相对时间标签(「刚刚 / N 分钟前」)的独家保鲜叶子:行主体 memo 化后不再逐
 * emit 重渲染,时间标签失去偶然保鲜会无限期冻结;而把分钟订阅挂在行本体又等于每分钟
 * 重画全列表重型子树。下沉到只渲染一个 Text 的叶子组件独家订阅 useMinuteNow。
 */
export function SessionRelativeTime({ lastActivityAt, style }: { lastActivityAt: string; style: StyleProp<TextStyle> }) {
  useMinuteNow();
  return (
    <Text style={style} numberOfLines={1}>
      {formatRemoteSessionSidebarTime(lastActivityAt)}
    </Text>
  );
}

/**
 * 任务信息槽(对齐桌面 SessionInfoMeta):按勾选顺序显示 时间 / PR / Token / 费用
 *(worktree 仅本机 Desktop,见 homeDisplaySettings),以「·」分隔;无数据的项不占位,全不选时不渲染。文字统一沿用行内时间的样式。
 */
type InfoSession = RemoteSessionListItem['session'] & {
  deviceLinkDeviceId?: string;
  totalCostUsd?: number;
  totalMoney?: unknown;
  totalTokenUsage?: number;
};

interface InfoMetaProps {
  item: RemoteSessionListItem;
  textStyle: StyleProp<TextStyle>;
}

export function HomeSessionInfoMeta(props: InfoMetaProps) {
  const { taskInfoFields } = useHomeRowDisplay();
  const needsPr = taskInfoFields.includes('pr');
  const needsUsage = taskInfoFields.includes('tokens') || taskInfoFields.includes('cost');
  // 只有勾选了 PR / Token / 费用的行才订阅对应数据;只显示时间等字段的行保持零额外订阅,
  // 不让设备在线状态或用量推送惊动整张 memo 化的列表。
  if (needsPr) return <InfoMetaWithPr {...props} fields={taskInfoFields} needsUsage={needsUsage} />;
  if (needsUsage) return <InfoMetaWithUsage {...props} fields={taskInfoFields} />;
  return <InfoMetaContent {...props} fields={taskInfoFields} pr={null} usage={null} />;
}

/** 首页列表投影不带用量(避免用量推送重排分组),勾选 Token / 费用时按任务单独订阅。 */
function InfoMetaWithUsage(props: InfoMetaProps & { fields: readonly HomeTaskInfoField[] }) {
  const usage = useRemoteSessionUsage(props.item.session.id);
  return <InfoMetaContent {...props} pr={null} usage={usage} />;
}

function InfoMetaWithPr({
  needsUsage,
  ...props
}: InfoMetaProps & { fields: readonly HomeTaskInfoField[]; needsUsage: boolean }) {
  const session = props.item.session as InfoSession;
  const pr = useHomeSessionPr(session.deviceLinkDeviceId, session.id, true, session.updatedAt);
  const usage = useRemoteSessionUsage(session.id, needsUsage);
  return <InfoMetaContent {...props} pr={pr} usage={needsUsage ? usage : null} />;
}

function InfoMetaContent({
  fields: taskInfoFields,
  item,
  pr,
  textStyle,
  usage,
}: InfoMetaProps & {
  fields: readonly HomeTaskInfoField[];
  pr: HomeSessionPrInfo | null;
  usage: RemoteSessionUsage | null;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const session = item.session as InfoSession;
  const pieces = buildHomeSessionInfoPieces(usage ? { ...session, ...pickDefinedUsage(usage) } : session, taskInfoFields)
    .filter((piece) => piece.key !== 'pr' || pr);
  if (pieces.length === 0) return null;
  return (
    <View style={styles.row} testID={`home.sessionInfo.${session.id}`}>
      {pieces.map((piece, index) => (
        <Fragment key={piece.key}>
          {/* 分隔符与行内时间同一文字角色与语义字色,不用透明度另造一档灰。 */}
          {index > 0 ? <Text accessible={false} style={textStyle}>·</Text> : null}
          {piece.key === 'time' ? (
            <SessionRelativeTime lastActivityAt={item.lastActivityAt} style={textStyle} />
          ) : piece.key === 'pr' && pr ? (
            <PrPiece
              color={prStatusVisual(pr.status?.ok ? pr.status.status : null, colors)}
              label={`#${pr.ref.prNumber}`}
              testID={`home.sessionInfo.pr.${session.id}`}
              textStyle={textStyle}
            />
          ) : 'text' in piece ? (
            <Text numberOfLines={1} style={textStyle}>{piece.text}</Text>
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

/** 实时用量缺字段时保留列表缓存里的值(冷启动先显示缓存,连上后再被实时值覆盖)。 */
function pickDefinedUsage(usage: RemoteSessionUsage): RemoteSessionUsage {
  const out: RemoteSessionUsage = {};
  if (usage.totalMoney !== undefined) out.totalMoney = usage.totalMoney;
  if (usage.totalCostUsd !== undefined) out.totalCostUsd = usage.totalCostUsd;
  if (usage.totalTokenUsage !== undefined) out.totalTokenUsage = usage.totalTokenUsage;
  return out;
}

/**
 * 行内 PR 信息。enabled=false(未勾选 PR / 非远程任务)时不订阅、不查询。
 * refreshKey 传任务的 updatedAt:任务有新动静时(可能刚提了 PR)提前重查。
 */
function useHomeSessionPr(
  deviceId: string | undefined,
  sessionId: string,
  enabled: boolean,
  refreshKey?: string,
): HomeSessionPrInfo | null {
  const link = useDeviceLink();
  const { accountGeneration } = useAuth();
  const key = enabled && deviceId
    ? homeSessionPrCacheKey(String(accountGeneration), deviceId, sessionId)
    : null;
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeHomeSessionPr(key, listener) : () => undefined),
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => (key ? readHomeSessionPr(key) : null));
  const online = !!deviceId
    && link.status === 'online'
    && link.getPresenceAvailability(deviceId) !== false;
  // 首页被别的页面盖住时任务行仍挂载;只在列表可见时查询,回到首页时按新鲜度补查一次。
  const { isActive, onResume } = useRemoteSessionStoreVisibility();
  useEffect(() => {
    if (!key || !deviceId || !online) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // eventful = 回到首页 / 回到前台:期间的轮询被跳过,PR 可能已合并或关闭,不沿用 90 秒缓存。
    const refresh = (eventful = false) => {
      if (AppState.currentState !== 'active' || !isActive()) return;
      const retryIn = refreshHomeSessionPr(key, (previous) => loadHomeSessionPr(link.invoke, deviceId, sessionId, previous), {
        eventful,
        now: Date.now(),
        refreshKey,
      });
      // 事件触发却撞上在途请求或 10 秒防抖:到点补查一次,不等下一轮轮询。
      if (retryIn > 0 && retry === undefined) {
        retry = setTimeout(() => {
          retry = undefined;
          refresh(true);
        }, retryIn);
      }
    };
    refresh();
    const timer = setInterval(() => refresh(), PR_STATUS_REFRESH_INTERVAL_MS);
    const stopResume = onResume(() => refresh(true));
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh(true);
    });
    return () => {
      clearInterval(timer);
      if (retry !== undefined) clearTimeout(retry);
      stopResume();
      appState.remove();
    };
  }, [deviceId, isActive, key, link.connectionEpoch, link.invoke, onResume, online, refreshKey, sessionId]);
  return value;
}

function PrPiece({
  color,
  label,
  testID,
  textStyle,
}: {
  color: ReturnType<typeof prStatusVisual>;
  label: string;
  testID: string;
  textStyle: StyleProp<TextStyle>;
}) {
  const { Icon } = color;
  return (
    <View style={styles.iconPiece} testID={testID}>
      <Icon color={color.color} size={iconSize.xs} strokeWidth={iconStroke.thin} />
      <Text numberOfLines={1} style={[textStyle, styles.tabular]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconPiece: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: spacing.xs,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: spacing.xs,
    maxWidth: '62%',
    overflow: 'hidden',
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
});
