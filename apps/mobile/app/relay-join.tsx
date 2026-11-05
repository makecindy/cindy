/**
 * 加入自建中转(docs/self-hosted-relay-plan.md §5.1):手机用系统相机扫电脑上的加入二维码,
 * 深链经 +native-intent 把链接留在内存(加入码不进路由状态),这里不带参数打开。
 *
 * 流程:探测中转(relay/info)→ 用户点「加入」→ 生成本机签名密钥,提交加入申请(上报与官方登录相同的
 * 设备 ID、当前账号、签名公钥和用链接里的配对秘密做的证明)→ 显示 4 位配对码,等主人在中转所在的电脑上
 * 核对并同意 → 用链接里的主人公钥核对证书(不是主人签发的就不加入,§16)→ 凭证与签名种子存进安全存储、
 * 切换到这个中转。凭证和种子只交给 saveSelfHostedRelay,不进状态、日志或界面。
 */
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, Server } from 'lucide-react-native';
import {
  acceptRelayDeviceCert,
  createRelayJoinIdentity,
  fetchRelayInfo,
  RelayJoinError,
  submitRelayPairRequest,
  waitForRelayApproval,
  type RelayInfo,
  type RelayJoinErrorCode,
  type RelayJoinLink,
} from '@cindy/device-link';

import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { APP_BINARY_VERSION } from '@/config/env';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { mobileRelayAuthCrypto } from '@/device-link/relayAuthCrypto';
import { clearRelayJoinIntent, usePendingRelayJoinIntent } from '@/device-link/relayJoinIntent';
import { createRelayJoinFetch, saveSelfHostedRelay, useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import {
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
} from '@/platform/chrome/SimpleStackHeader';
import { monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

/** 探测与提交是小请求;等待同意是长轮询(中转最多挂 20 秒),每轮留出余量。 */
const REQUEST_TIMEOUT_MS = 12_000;
const APPROVAL_POLL_TIMEOUT_MS = 35_000;

type JoinErrorCode = RelayJoinErrorCode | 'SAVE_FAILED';

type Phase =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ready'; info: RelayInfo }
  | { kind: 'submitting'; info: RelayInfo }
  | { kind: 'waiting'; info: RelayInfo; verifyCode: string }
  | { kind: 'joined'; info: RelayInfo }
  | { kind: 'failed'; info: RelayInfo | null; code: JoinErrorCode; retry: 'probe' | 'join' | null };

const ERROR_MESSAGE_KEYS: Record<JoinErrorCode, string> = {
  UNREACHABLE: 'relay.errors.unreachable',
  NOT_A_RELAY: 'relay.errors.notRelay',
  INCOMPATIBLE: 'relay.errors.incompatible',
  ACCOUNT_MISMATCH: 'relay.errors.accountMismatch',
  CODE_INVALID: 'relay.errors.codeInvalid',
  RATE_LIMITED: 'relay.errors.rateLimited',
  REJECTED: 'relay.errors.rejected',
  EXPIRED: 'relay.errors.expired',
  OWNER_MISMATCH: 'relay.errors.ownerMismatch',
  CANCELLED: 'relay.join.cancelled',
  FAILED: 'relay.errors.failed',
  SAVE_FAILED: 'relay.errors.saveFailed',
};

/** 加入码还没交给中转时,这些失败可以原样重试;交出去之后中转已作废它,只能在电脑上重新生成。 */
const RETRYABLE_BEFORE_SUBMIT: ReadonlySet<JoinErrorCode> = new Set(['UNREACHABLE', 'RATE_LIMITED', 'FAILED']);

function joinErrorCode(error: unknown): JoinErrorCode {
  return error instanceof RelayJoinError ? error.code : 'FAILED';
}

function errorMessageKey(code: JoinErrorCode, link: RelayJoinLink | null): string {
  // 手机正式包只能用受信任的 https 连接中转(§1):明文地址连不上时直接说清原因。
  if (code === 'UNREACHABLE' && link?.baseUrl.startsWith('http:')) return 'relay.errors.insecureUnreachable';
  return ERROR_MESSAGE_KEYS[code];
}

export default function RelayJoinScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const auth = useAuth();
  const currentRelay = useSelfHostedRelay();
  const intent = usePendingRelayJoinIntent();
  // 页面自己留一份链接:加入码一交给中转就清掉内存里的待处理链接,但等待同意还要用地址。
  const [link, setLink] = useState<RelayJoinLink | null>(() => intent?.link ?? null);
  const intentIdRef = useRef(intent?.id ?? 0);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const restartFlow = useCallback((): AbortController => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 页面开着时又扫了一个新链接:放弃当前流程,换成新链接。
  useEffect(() => {
    if (!intent || intent.id === intentIdRef.current) return;
    intentIdRef.current = intent.id;
    abortRef.current?.abort();
    setLink(intent.link);
    setPhase({ kind: 'idle' });
  }, [intent]);

  const probe = useCallback(async (target: RelayJoinLink) => {
    const controller = restartFlow();
    setPhase({ kind: 'probing' });
    try {
      const info = await fetchRelayInfo(createRelayJoinFetch(REQUEST_TIMEOUT_MS), target.baseUrl, controller.signal);
      if (!controller.signal.aborted) setPhase({ kind: 'ready', info });
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhase({ kind: 'failed', info: null, code: joinErrorCode(error), retry: 'probe' });
      }
    }
  }, [restartFlow]);

  const signedIn = auth.isAuthenticated;
  useEffect(() => {
    if (link && signedIn && phase.kind === 'idle') void probe(link);
  }, [link, phase.kind, probe, signedIn]);

  const join = useCallback(async (info: RelayInfo) => {
    if (!link) return;
    const owner = getMobileAuthOwner();
    const accountUserId = auth.user?.id;
    const deviceId = auth.deviceId;
    if (!owner.accountKey || owner.switching || !accountUserId || !deviceId) {
      setPhase({ kind: 'failed', info, code: 'FAILED', retry: 'join' });
      return;
    }
    const controller = restartFlow();
    setPhase({ kind: 'submitting', info });
    let codeSubmitted = false;
    try {
      // 本机签名密钥:公钥连同用链接里配对秘密做的证明一起提交,中转换不掉它。
      const identity = createRelayJoinIdentity(mobileRelayAuthCrypto, link, info.relayId, deviceId);
      const request = await submitRelayPairRequest(
        createRelayJoinFetch(REQUEST_TIMEOUT_MS),
        link,
        {
          deviceId,
          deviceName: buildMobileDeviceName({ constantsDeviceName: Constants.deviceName, platform: Platform.OS }),
          platform: Platform.OS === 'android' ? 'android' : 'ios',
          appVersion: APP_BINARY_VERSION || Constants.expoConfig?.version || '',
          accountUserId,
          publicKey: identity.publicKey,
          proof: identity.proof,
        },
        controller.signal,
      );
      // 中转已作废这个加入码:内存里不再留它。
      codeSubmitted = true;
      clearRelayJoinIntent();
      if (controller.signal.aborted) return;
      setPhase({ kind: 'waiting', info, verifyCode: request.verifyCode });
      const approved = await waitForRelayApproval(
        createRelayJoinFetch(APPROVAL_POLL_TIMEOUT_MS),
        link,
        request,
        { signal: controller.signal },
      );
      // 证书必须出自链接里的主人、发给本机这把公钥;否则中转可能被人替换,不加入(抛 OWNER_MISMATCH)。
      acceptRelayDeviceCert(mobileRelayAuthCrypto, link, {
        relayId: info.relayId,
        deviceId,
        publicKey: identity.publicKey,
        cert: approved.cert,
      });
      // 凭证只返回一次:拿到就保存,哪怕页面刚好被关掉。
      try {
        await saveSelfHostedRelay({
          owner,
          relayId: info.relayId,
          name: info.name,
          baseUrl: link.baseUrl,
          deviceId,
          ownerPublicKey: link.ownerPublicKey,
          credential: approved.credential,
          seed: identity.seed,
        });
      } catch {
        if (!controller.signal.aborted) setPhase({ kind: 'failed', info, code: 'SAVE_FAILED', retry: null });
        return;
      }
      if (!controller.signal.aborted) setPhase({ kind: 'joined', info });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = joinErrorCode(error);
      setPhase({
        kind: 'failed',
        info,
        code,
        retry: !codeSubmitted && RETRYABLE_BEFORE_SUBMIT.has(code) ? 'join' : null,
      });
    }
  }, [auth.deviceId, auth.user?.id, link, restartFlow]);

  const cancelWaiting = useCallback(() => {
    if (phase.kind !== 'waiting') return;
    setPhase({ kind: 'failed', info: phase.info, code: 'CANCELLED', retry: null });
    abortRef.current?.abort();
  }, [phase]);

  const leave = useCallback(() => {
    abortRef.current?.abort();
    goBackGuarded(router);
  }, [router]);

  const retry = useCallback(() => {
    if (phase.kind !== 'failed' || !link) return;
    if (phase.retry === 'probe') void probe(link);
    else if (phase.retry === 'join' && phase.info) void join(phase.info);
  }, [join, link, phase, probe]);

  const switchNote = currentRelay && link && currentRelay.baseUrl !== link.baseUrl
    ? t('relay.join.switchNote', { current: currentRelay.name })
    : null;

  let content: ReactNode;
  if (!link) {
    content = (
      <Notice
        icon={<CircleAlert size={iconSize.xl} color={colors.textSecondary} />}
        message={t('relay.join.invalidLink')}
        action={{ label: t('relay.join.done'), onPress: leave, testID: 'relayJoin.done' }}
      />
    );
  } else if (!signedIn) {
    content = (
      <Notice
        icon={<Server size={iconSize.xl} color={colors.textSecondary} />}
        message={t('relay.join.signedOut')}
        action={{ label: t('relay.join.signIn'), onPress: () => router.replace('/login'), testID: 'relayJoin.signIn', primary: true }}
      />
    );
  } else if (phase.kind === 'idle' || phase.kind === 'probing') {
    content = (
      <View style={styles.loading} testID="relayJoin.checking">
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.note}>{t('relay.join.checking')}</Text>
      </View>
    );
  } else if (phase.kind === 'ready' || phase.kind === 'submitting') {
    content = (
      <>
        <RelayIdentity info={phase.info} baseUrl={link.baseUrl} />
        <Text style={styles.body}>{t('relay.join.body')}</Text>
        {switchNote ? <Text style={styles.note}>{switchNote}</Text> : null}
        <View style={styles.actions}>
          <MainWindowActionButton
            action={{
              label: t('relay.join.action'),
              tone: 'primary',
              busy: phase.kind === 'submitting',
              onPress: () => { void join(phase.info); },
              testID: 'relayJoin.join',
            }}
          />
        </View>
      </>
    );
  } else if (phase.kind === 'waiting') {
    content = (
      <>
        <RelayIdentity info={phase.info} baseUrl={link.baseUrl} />
        <View style={styles.codeBlock}>
          <Text style={styles.sectionLabel}>{t('relay.join.pairingCodeLabel')}</Text>
          <Text
            accessibilityLabel={`${t('relay.join.pairingCodeLabel')} ${phase.verifyCode.split('').join(' ')}`}
            selectable
            style={styles.pairingCode}
            testID="relayJoin.pairingCode"
          >
            {phase.verifyCode}
          </Text>
        </View>
        <Text style={styles.body}>{t('relay.join.verifyHint')}</Text>
        <View style={styles.waitingRow}>
          <ActivityIndicator color={colors.textSecondary} size="small" />
          <Text accessibilityLiveRegion="polite" style={styles.note}>{t('relay.join.waiting')}</Text>
        </View>
        <View style={styles.actions}>
          <MainWindowActionButton
            action={{ label: t('relay.join.cancel'), onPress: cancelWaiting, testID: 'relayJoin.cancel' }}
          />
        </View>
      </>
    );
  } else if (phase.kind === 'joined') {
    content = (
      <Notice
        icon={<CircleCheck size={iconSize.xl} color={colors.textSecondary} />}
        heading={t('relay.join.joinedTitle')}
        message={t('relay.join.joinedBody', { name: phase.info.name })}
        action={{ label: t('relay.join.done'), onPress: () => router.replace('/'), testID: 'relayJoin.done', primary: true }}
      />
    );
  } else {
    content = (
      <>
        {phase.info ? <RelayIdentity info={phase.info} baseUrl={link.baseUrl} /> : null}
        <Notice
          icon={phase.info ? null : <CircleAlert size={iconSize.xl} color={colors.textSecondary} />}
          message={t(errorMessageKey(phase.code, link))}
          action={phase.retry
            ? { label: t('relay.join.retry'), onPress: retry, testID: 'relayJoin.retry', primary: true }
            : { label: t('relay.join.done'), onPress: leave, testID: 'relayJoin.done' }}
        />
      </>
    );
  }

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.screen} testID="relayJoin.screen">
      <SimpleStackHeader
        scrollEdge
        title={t('relay.join.title')}
        backTestID="relayJoin.back"
        onBack={leave}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content}>
        {content}
      </ScrollView>
    </SafeAreaView>
  );
}

/** 中转名称与地址:名称来自 relay/info,地址来自加入链接,让用户在点加入前看清连的是谁。 */
function RelayIdentity({ info, baseUrl }: { info: RelayInfo; baseUrl: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.identity}>
      <View style={styles.icon}>
        <Server size={iconSize.xl} color={colors.textSecondary} />
      </View>
      <Text accessibilityRole="header" style={styles.heading}>{info.name}</Text>
      <Text selectable style={styles.note} testID="relayJoin.address">{baseUrl}</Text>
    </View>
  );
}

function Notice({
  icon,
  heading,
  message,
  action,
}: {
  icon?: ReactNode;
  heading?: string;
  message: string;
  action: { label: string; onPress: () => void; testID: string; primary?: boolean };
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      {heading ? <Text accessibilityRole="header" style={styles.heading}>{heading}</Text> : null}
      <Text accessibilityLiveRegion="polite" style={styles.body}>{message}</Text>
      <View style={styles.actions}>
        <MainWindowActionButton
          action={{
            label: action.label,
            tone: action.primary ? 'primary' : 'secondary',
            onPress: action.onPress,
            testID: action.testID,
          }}
        />
      </View>
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg, paddingTop: spacing.xl },
  identity: { alignItems: 'flex-start', gap: spacing.xs },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    marginBottom: spacing.xs,
    width: 48,
  },
  // 页面大标题:20/25 600 textPrimary。
  heading: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.title,
  },
  // 次级正文:15/20 400 textSecondary。
  body: {
    color: colors.textSecondary,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
  },
  // 说明 / 提示:13/18 400 textSecondary。
  note: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  // 分组小标签:13/18 600 textTertiary。
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
  },
  codeBlock: {
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  // 配对码是要和电脑逐位核对的大数字:30/36 600 textPrimary,等宽字体对齐每一位。
  pairingCode: {
    color: colors.textPrimary,
    fontFamily: monoFont,
    fontSize: typeScale.largeTitle,
    fontWeight: fontWeight.semibold,
    letterSpacing: spacing.sm,
    lineHeight: lineHeight.largeTitle,
  },
  loading: { alignItems: 'center', alignSelf: 'stretch', gap: spacing.sm, paddingVertical: spacing.xl },
  waitingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  actions: { alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm },
});
