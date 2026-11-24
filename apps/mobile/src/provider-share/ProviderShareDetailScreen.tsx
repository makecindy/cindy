/**
 * 一个分享出去的供应商在手机上的管理页(产品规则 provider-sharing.md §7.6)：
 *  - 待处理：申请人的昵称和头像、配对码，同意或拒绝(与电脑上的审批弹窗同一套告知)；
 *  - 分享链接：生成一次性链接，5 分钟倒计时，复制或用系统分享发给对方；
 *  - 电脑与额度：这个供应商(或它的供应商组)里每台电脑的状态与各账号的剩余额度；
 *  - 已分享的人：只读名单。暂停、删除与组设置仍在电脑上。
 *
 * 同意前必须先在那台电脑的目录里找到这个供应商：确认它是不是 Claude 订阅登录、有没有建组，
 * 才不会漏掉邮箱告知或说错 Agent 在哪运行(与 Desktop 审批弹窗同一道核对)。
 * 链接只留在这一页的内存里，离开即丢弃。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, StatusDot } from '@/components/MobilePrimitives';
import { MobileUserAvatar } from '@/components/MobileUserAvatar';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { writeClipboardText } from '@/session/messageActions';
import { ModelQuotaBar } from '@/session/ModelQuotaBar';
import { ActionInfoRow, SettingsGroup, useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { formatQuotaResetCountdown, formatSessionUsageMoney } from '@/session/sessionUsagePresentation';
import { monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

import type {
  ShareGroupMember,
  ShareManagementErrorCode,
  ShareManagementMember,
  ShareManagementRequest,
  ShareQuotaAccount,
  ShareQuotaWindow,
} from './providerShareManagement';
import {
  formatShareCountdown,
  providerHasGroup,
  shareLinkGate,
  shareMemberStatus,
  sharesClaudeLoginEmail,
  type ShareLinkGate,
} from './providerShareManagementPresentation';
import {
  SHARE_HOST_QUOTA_KEY,
  useProviderShareDetail,
  type ShareDecisionNotice,
  type ShareQuotaReading,
} from './useProviderShareDetail';

export default function ProviderShareDetailScreen() {
  const { accountGeneration } = useAuth();
  const params = useLocalSearchParams<{ deviceId: string; providerId: string; label?: string; deviceName?: string }>();
  return (
    <ProviderShareDetailContent
      key={`${accountGeneration}:${params.deviceId}:${params.providerId}`}
      deviceId={params.deviceId}
      deviceName={params.deviceName ?? ''}
      label={params.label ?? ''}
      providerId={params.providerId}
    />
  );
}

/** 「3 分钟前」这类相对时间，沿用任务列表的同一组文案。 */
function relativeTime(timestampMs: number, nowMs: number, t: TFunction): string {
  const minutes = Math.max(0, Math.floor((nowMs - timestampMs) / 60_000));
  if (minutes < 1) return t('devices.presentation.sessionList.time.justNow');
  if (minutes < 60) return t('devices.presentation.sessionList.time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t('devices.presentation.sessionList.time.hoursAgo', { count: hours })
    : t('devices.presentation.sessionList.time.daysAgo', { count: Math.floor(hours / 24) });
}

function noticeText(notice: ShareDecisionNotice, provider: string, t: TFunction): string {
  switch (notice.kind) {
    case 'approved':
      return t('providerShare.manage.pending.approved', { name: notice.name, provider });
    case 'rejected':
      return t('providerShare.manage.pending.rejected', { name: notice.name });
    case 'gone':
      return t('providerShare.manage.pending.gone');
    case 'uncertain':
      return t('providerShare.manage.pending.uncertain');
    case 'needs-update':
      return t('providerShare.manage.needsUpdate');
    default:
      return t('providerShare.manage.pending.failed');
  }
}

/** 读取失败时接在分组后面的说明；能自动恢复的写明会重试。 */
function readErrorText(code: ShareManagementErrorCode, t: TFunction): string {
  if (code === 'needs-update') return t('providerShare.manage.needsUpdate');
  if (code === 'offline') return t('providerShare.manage.offline');
  if (code === 'not-ready') return t('providerShare.manage.notReady');
  return t('providerShare.manage.loadFailed');
}

function gateText(gate: Exclude<ShareLinkGate, 'ready' | 'checking'>, t: TFunction): string {
  if (gate === 'invocation-off') return t('providerShare.manage.link.gateInvocation');
  if (gate === 'disconnected') return t('providerShare.manage.computers.status.unavailable.disconnected');
  return t('providerShare.manage.link.gateMissing');
}

function ProviderShareDetailContent({ deviceId, deviceName, label, providerId }: {
  deviceId: string;
  deviceName: string;
  label: string;
  providerId: string;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const detail = useProviderShareDetail({ active: useIsFocused(), deviceId, providerId });
  const catalog = useDeviceProviders(deviceId);
  const provider = catalog.ready ? catalog.providers.find((entry) => entry.id === providerId) : undefined;
  // 目录没读出来时不写「正在确认」，也不当成供应商不在了：单独说明，生成链接与同意都不开放。
  const catalogFailed = !catalog.ready && catalog.error !== null;
  const gate = shareLinkGate({ catalogReady: catalog.ready, provider });
  const providerLabel = detail.share?.providerLabel || provider?.name || label;
  const [pulling, setPulling] = useState(false);
  const [copyNotice, setCopyNotice] = useState<'copied' | 'copyFailed' | null>(null);
  const { refresh } = detail;
  const pull = useCallback(() => {
    setPulling(true);
    void refresh().finally(() => setPulling(false));
  }, [refresh]);

  const link = detail.link.status === 'ready' ? detail.link.link : null;
  const remainingMs = link ? link.expiresAtMs - detail.now : 0;
  const linkLive = link !== null && remainingMs > 0;
  useEffect(() => { setCopyNotice(null); }, [link?.linkId]);

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await writeClipboardText(link.link);
      setCopyNotice('copied');
    } catch {
      setCopyNotice('copyFailed');
    }
  }, [link]);
  const send = useCallback(() => {
    // 系统分享面板由用户自己选渠道；取消或失败都不改变链接状态。
    if (link) void Share.share({ message: link.link }).catch(() => undefined);
  }, [link]);

  const requests = detail.share?.requests ?? [];
  const members = detail.share?.members ?? [];
  // 同一时间只发一个写请求：生成链接与处理申请进行中时，另一类按钮一并停用，不留点了没反应的按钮。
  const writing = detail.deciding !== null || detail.link.status === 'creating';
  const grouped = detail.group?.grouped === true || providerHasGroup(provider);
  // 同意前的核对：目录里确有这个供应商(类型、有没有组都已知)。
  const approvalReady = provider !== undefined;

  const computers: ShareGroupMember[] | null = detail.group === null
    ? null
    : detail.group.grouped
      ? detail.group.members
      : null;

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.screen} testID="providerShareDetail.screen">
      <SimpleStackHeader
        scrollEdge
        title={providerLabel}
        backTestID="providerShareDetail.back"
        onBack={() => goBackGuarded(router)}
      />
      <ScrollView
        {...simpleScrollInsetProps}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} tintColor={colors.textSecondary} />}
        testID="providerShareDetail.scroll"
      >
        {detail.notice ? (
          <Text accessibilityLiveRegion="polite" style={styles.note} testID="providerShareDetail.notice">
            {noticeText(detail.notice, providerLabel, t)}
          </Text>
        ) : null}

        {requests.length > 0 ? (
          <SettingsGroup
            footer={t('providerShare.manage.pending.pairingHint')}
            messages={[
              approvalReady ? null : {
                text: catalogFailed
                  ? t('providerShare.manage.loadFailed')
                  : gate === 'checking'
                    ? t('providerShare.manage.pending.checking')
                    : t('providerShare.manage.link.gateMissing'),
                testID: 'providerShareDetail.approvalBlocked',
              },
            ]}
            testID="providerShareDetail.pending"
            title={t('providerShare.manage.pending.title')}
          >
            {requests.map((request) => (
              <PendingRequestRow
                key={request.requestId}
                approvalReady={approvalReady}
                claudeEmail={sharesClaudeLoginEmail(provider)}
                deciding={detail.deciding?.requestId === request.requestId ? detail.deciding.decision : null}
                disabled={writing}
                grouped={grouped}
                now={Date.now()}
                onDecide={detail.decide}
                provider={providerLabel}
                request={request}
              />
            ))}
          </SettingsGroup>
        ) : null}

        {linkLive && link ? (
          <SettingsGroup
            footer={t('providerShare.manage.link.footer')}
            messages={[copyNotice ? { text: t(`providerShare.manage.link.${copyNotice}`), testID: 'providerShareDetail.copyNotice' } : null]}
            testID="providerShareDetail.link"
            title={t('providerShare.manage.link.title')}
          >
            <View style={styles.block}>
              <Text selectable numberOfLines={3} style={styles.linkText} testID="providerShareDetail.linkText">{link.link}</Text>
              <Text style={styles.detailLine} testID="providerShareDetail.countdown">
                {`${t('providerShare.manage.link.oneTime')} · ${t('providerShare.manage.link.expiresIn', { time: formatShareCountdown(remainingMs) })}`}
              </Text>
              <View style={styles.actions}>
                <MainWindowActionButton
                  action={{ label: t('providerShare.manage.link.send'), onPress: send, testID: 'providerShareDetail.sendLink' }}
                  grow
                />
                <MainWindowActionButton
                  action={{
                    label: t('providerShare.manage.link.copy'),
                    onPress: () => { void copy(); },
                    testID: 'providerShareDetail.copyLink',
                    tone: 'primary',
                  }}
                  grow
                />
              </View>
              {/* 这条链接带来的申请一到，链接就算用掉、这一块随之收起(见 useProviderShareDetail)。 */}
              {detail.watching ? (
                <View style={styles.waiting}>
                  <ActivityIndicator color={colors.textSecondary} size="small" />
                  <Text accessibilityLiveRegion="polite" style={styles.detailLine}>{t('providerShare.manage.link.waiting')}</Text>
                </View>
              ) : null}
            </View>
          </SettingsGroup>
        ) : gate === 'ready' ? (
          <SettingsGroup
            footer={t('providerShare.manage.link.footer')}
            messages={[
              link ? { text: t('providerShare.manage.link.expired'), testID: 'providerShareDetail.linkExpired' } : null,
              detail.link.status === 'error'
                ? {
                    text: detail.link.code === 'needs-update'
                      ? t('providerShare.manage.link.needsUpdate')
                      : detail.link.code === 'offline'
                        ? t('providerShare.manage.offline')
                        : detail.link.code === 'not-ready'
                          ? t('providerShare.manage.notReady')
                          : t('providerShare.manage.link.failed'),
                    testID: 'providerShareDetail.linkError',
                  }
                : null,
            ]}
            testID="providerShareDetail.link"
            title={t('providerShare.manage.link.title')}
          >
            <ActionInfoRow
              accessibilityLabel={t(link ? 'providerShare.manage.link.regenerate' : 'providerShare.manage.link.create')}
              chevron={false}
              disabled={writing}
              label={t(detail.link.status === 'creating'
                ? 'providerShare.manage.link.generating'
                : link ? 'providerShare.manage.link.regenerate' : 'providerShare.manage.link.create')}
              onPress={detail.createLink}
              testID="providerShareDetail.createLink"
            />
          </SettingsGroup>
        ) : catalogFailed ? (
          <Text style={styles.note} testID="providerShareDetail.linkGate">{t('providerShare.manage.loadFailed')}</Text>
        ) : gate === 'checking' ? (
          <View style={styles.waiting}>
            <ActivityIndicator color={colors.textSecondary} size="small" />
            <Text style={styles.note}>{t('providerShare.manage.link.checking')}</Text>
          </View>
        ) : (
          <Text style={styles.note} testID="providerShareDetail.linkGate">{gateText(gate, t)}</Text>
        )}

        {detail.group !== null ? (
          <SettingsGroup
            footer={t('providerShare.manage.computers.footer')}
            messages={[detail.groupError ? { text: readErrorText(detail.groupError, t) } : null]}
            testID="providerShareDetail.computers"
            title={t('providerShare.manage.computers.title')}
          >
            {computers
              ? computers.map((member) => (
                  <ComputerRow
                    key={member.key}
                    member={member}
                    now={Date.now()}
                    reading={member.quotaTarget ? detail.quotas[member.key] : undefined}
                  />
                ))
              : (
                  <View style={styles.block} testID="providerShareDetail.host">
                    {deviceName ? <Text style={styles.computerName}>{deviceName}</Text> : null}
                    <QuotaBlock now={Date.now()} reading={detail.quotas[SHARE_HOST_QUOTA_KEY]} />
                  </View>
                )}
          </SettingsGroup>
        ) : detail.groupError ? (
          <Text style={styles.note}>{readErrorText(detail.groupError, t)}</Text>
        ) : null}

        {members.length > 0 ? (
          <SettingsGroup
            footer={t('providerShare.manage.members.footer')}
            messages={[detail.sharesError ? { text: readErrorText(detail.sharesError, t) } : null]}
            testID="providerShareDetail.members"
            title={t('providerShare.manage.members.title')}
          >
            {members.map((member) => <MemberRow key={member.memberId} member={member} />)}
          </SettingsGroup>
        ) : detail.sharesError ? (
          <Text accessibilityLiveRegion="polite" style={styles.note} testID="providerShareDetail.sharesError">
            {readErrorText(detail.sharesError, t)}
          </Text>
        ) : detail.sharesLoaded ? (
          <Text style={styles.note} testID="providerShareDetail.noMembers">{t('providerShare.manage.members.empty')}</Text>
        ) : (
          <ActivityIndicator color={colors.textSecondary} style={styles.loading} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PendingRequestRow({ approvalReady, claudeEmail, deciding, disabled, grouped, now, onDecide, provider, request }: {
  approvalReady: boolean;
  claudeEmail: boolean;
  deciding: 'approve' | 'reject' | null;
  disabled: boolean;
  grouped: boolean;
  now: number;
  onDecide(request: ShareManagementRequest, decision: 'approve' | 'reject'): void;
  provider: string;
  request: ShareManagementRequest;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const name = request.displayName;
  return (
    <View style={styles.block} testID={`providerShareDetail.request.${request.requestId}`}>
      <View style={styles.person}>
        <MobileUserAvatar imageUrl={request.avatarUrl} name={name} size="small" />
        <View style={styles.personText}>
          <Text style={styles.personName}>{t('providerShare.manage.pending.heading', { name, provider })}</Text>
          <Text style={styles.detailLine}>
            {t('providerShare.manage.pending.requestedAt', { time: relativeTime(request.createdAtMs, now, t) })}
          </Text>
        </View>
      </View>
      <View style={styles.codeBlock}>
        <Text style={styles.sectionLabel}>{t('providerShare.manage.pending.pairingLabel')}</Text>
        <Text
          accessibilityLabel={t('providerShare.manage.pending.pairingAria', { digits: request.pairingCode.split('').join(' ') })}
          selectable
          style={styles.pairingCode}
          testID={`providerShareDetail.pairingCode.${request.requestId}`}
        >
          {request.pairingCode}
        </Text>
      </View>
      <Text style={styles.detailLine}>
        {t(grouped ? 'providerShare.manage.pending.calloutGroup' : 'providerShare.manage.pending.callout', { name, provider })}
      </Text>
      {claudeEmail ? (
        <Text style={styles.detailLine} testID={`providerShareDetail.claudeEmail.${request.requestId}`}>
          {t('providerShare.manage.pending.calloutClaudeEmail', { name })}
        </Text>
      ) : null}
      <Text style={styles.detailLine}>{t('providerShare.manage.pending.calloutUnknown')}</Text>
      <View style={styles.actions}>
        <MainWindowActionButton
          action={{
            busy: deciding === 'reject',
            disabled: disabled && deciding !== 'reject',
            label: t('providerShare.manage.pending.reject'),
            onPress: () => onDecide(request, 'reject'),
            testID: `providerShareDetail.reject.${request.requestId}`,
          }}
          grow
        />
        <MainWindowActionButton
          action={{
            busy: deciding === 'approve',
            disabled: !approvalReady || (disabled && deciding !== 'approve'),
            label: t('providerShare.manage.pending.approve'),
            onPress: () => onDecide(request, 'approve'),
            testID: `providerShareDetail.approve.${request.requestId}`,
            tone: 'primary',
          }}
          grow
        />
      </View>
    </View>
  );
}

function ComputerRow({ member, now, reading }: {
  member: ShareGroupMember;
  now: number;
  reading: ShareQuotaReading | undefined;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const rowStyles = useSettingsRowStyles();
  const status = shareMemberStatus(member, now);
  const computer = member.kind === 'share'
    ? member.ownerName
      ? t('providerShare.manage.computers.shareComputer', { name: member.ownerName })
      : t('providerShare.manage.computers.shareComputerUnknown')
    : member.label;
  const reset = status.resetAtMs ? formatQuotaResetCountdown(status.resetAtMs / 1000, now, t) : null;
  const statusText = t(`providerShare.manage.computers.${status.key}`, status.count === undefined ? undefined : { count: status.count });
  return (
    <View style={styles.block} testID={`providerShareDetail.computer.${member.key}`}>
      <View style={rowStyles.rowLine}>
        <StatusDot tone={status.tone} />
        <Text style={rowStyles.rowLabel}>{member.providerName ? `${computer} · ${member.providerName}` : computer}</Text>
        <Text numberOfLines={2} style={rowStyles.rowValue}>
          {reset ? `${statusText} · ${t('models.unified.quotaResetIn', { duration: reset })}` : statusText}
        </Text>
      </View>
      {member.quotaTarget ? <QuotaBlock now={now} reading={reading} /> : null}
    </View>
  );
}

function quotaStateText(state: Exclude<ShareQuotaAccount['state'], 'ready'>, t: TFunction): string {
  if (state === 'needs-update') return t('providerShare.manage.computers.quota.needsUpdate');
  return t(`providerShare.manage.computers.quota.${state}`);
}

function QuotaBlock({ now, reading }: { now: number; reading: ShareQuotaReading | undefined }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  if (!reading || reading.status === 'loading') {
    return <Text style={styles.detailLine}>{t('providerShare.manage.computers.quota.loading')}</Text>;
  }
  if (reading.status === 'error') {
    return (
      <Text style={styles.detailLine}>
        {reading.code === 'needs-update'
          ? t('providerShare.manage.computers.quota.needsUpdate')
          : reading.code === 'offline'
            ? t('providerShare.manage.computers.quota.offline')
            : t('providerShare.manage.computers.quota.unavailable')}
      </Text>
    );
  }
  const several = reading.accounts.length > 1;
  return (
    <View style={styles.quota}>
      {reading.accounts.map((account, index) => (
        // 账号没有可公开的稳定标识，按返回顺序区分(与「账号 N」的写法一致)。
        <View key={index} style={styles.quotaAccount}>
          {several ? (
            <Text style={styles.sectionLabel}>{t('providerShare.manage.computers.quota.account', { number: index + 1 })}</Text>
          ) : null}
          {account.state !== 'ready' ? (
            <Text style={styles.detailLine}>{quotaStateText(account.state, t)}</Text>
          ) : account.windows.length === 0 && !account.balance ? (
            <Text style={styles.detailLine}>{t('providerShare.manage.computers.quota.none')}</Text>
          ) : (
            <>
              {account.windows.map((window, position) => (
                <QuotaWindowLine key={`${window.kind}:${window.label ?? ''}:${position}`} now={now} window={window} />
              ))}
              {account.balance ? (
                <View style={styles.quotaLine}>
                  <Text style={styles.quotaLabel}>{t('session.menu.usage.balance')}</Text>
                  <Text style={styles.quotaValue}>
                    {formatSessionUsageMoney({
                      amount: account.balance.remaining,
                      currency: account.balance.currency,
                      // 账上的实际余额，不是估算值。
                      approximate: false,
                      kind: 'actual-cost',
                    })}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      ))}
    </View>
  );
}

function QuotaWindowLine({ now, window }: { now: number; window: ShareQuotaWindow }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const label = window.kind === 'scoped' && window.label
    ? window.label
    : t(`providerShare.manage.computers.quota.${window.kind}`);
  const remaining = t('session.menu.usage.remaining', { percent: Math.round(window.remainingPercent) });
  const reset = window.resetsAtMs
    ? formatQuotaResetCountdown(window.resetsAtMs / 1000, now, t, window.windowMinutes)
    : null;
  return (
    <View style={styles.quotaWindow}>
      <View style={styles.quotaLine}>
        <Text style={styles.quotaLabel}>{label}</Text>
        <Text style={styles.quotaValue}>{remaining}</Text>
      </View>
      <ModelQuotaBar label={`${label}, ${remaining}`} remaining={window.remainingPercent} style={styles.quotaBar} />
      {reset ? <Text style={styles.metadata}>{t('models.unified.quotaResetIn', { duration: reset })}</Text> : null}
    </View>
  );
}

function MemberRow({ member }: { member: ShareManagementMember }) {
  const { t } = useTranslation();
  const rowStyles = useSettingsRowStyles();
  const status = member.status === 'paused'
    ? t('providerShare.manage.members.statusPaused')
    : member.runningTasks > 0
      ? t('providerShare.manage.members.statusRunning', { count: member.runningTasks })
      : t('providerShare.manage.members.statusActive');
  // 有备注时用备注称呼(与电脑上的管理页一致)，备注只有分享者自己看得到。
  const name = member.note || member.displayName;
  return (
    <View
      accessible
      accessibilityLabel={`${name}, ${status}`}
      style={[rowStyles.row, rowStyles.mediaRow]}
      testID={`providerShareDetail.member.${member.memberId}`}
    >
      <View style={rowStyles.rowLine}>
        <MobileUserAvatar imageUrl={member.avatarUrl} name={member.displayName} size="small" />
        <Text style={rowStyles.rowLabel}>{name}</Text>
        <Text numberOfLines={2} style={rowStyles.rowValue}>{status}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  loading: { paddingVertical: spacing.lg },
  // 卡片里自绘的一块(申请、链接、一台电脑)：与设置行同一套内边距。
  block: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  // 说明、提示(成句的话)：13/18 400 textSecondary；左右与分组标题对齐。
  note: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  // 卡片内的说明：13/18 400 textSecondary。
  detailLine: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontVariant: ['tabular-nums'],
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  // 时间、计数(短元数据)：12/18 400 textTertiary。
  metadata: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontVariant: ['tabular-nums'],
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  // 分组小标签：13/18 600 textTertiary。
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
  },
  person: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  personText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  // 行标题：16/22 500 textPrimary。
  personName: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  computerName: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  codeBlock: { gap: spacing.xs },
  // 配对码是要和对方逐位核对的大数字：30/36 600 textPrimary，等宽字体对齐每一位(与加入中转页同一写法)。
  pairingCode: {
    color: colors.textPrimary,
    fontFamily: monoFont,
    fontSize: typeScale.largeTitle,
    fontWeight: fontWeight.semibold,
    letterSpacing: spacing.sm,
    lineHeight: lineHeight.largeTitle,
  },
  // 等宽代码：15/20 400 textPrimary。
  linkText: {
    color: colors.textPrimary,
    fontFamily: monoFont,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  waiting: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  quota: { gap: spacing.md },
  quotaAccount: { gap: spacing.sm },
  quotaWindow: { gap: spacing.xs },
  quotaLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  // 额度行两端：13/18 400 textSecondary。
  quotaLabel: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  quotaValue: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontVariant: ['tabular-nums'],
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  // 整行宽的额度条：沿用模型选择器的 3pt 条与同一套余量配色，只改宽度。
  quotaBar: { alignSelf: 'stretch', width: '100%' },
});
