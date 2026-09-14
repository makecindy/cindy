// 整包更新发现 hook:拉 /latest → 比对 runtimeVersion → 弹窗引导打开正常安装入口。
//
// 用在两处:
// - 启动时自动检查(app/_layout.tsx);
// - 设置页统一"检查更新"入口先手动触发整包检查(返回 checkNow 的明确结果)。
// 判定逻辑全在纯函数 evaluateBundleUpdate 里,本 hook 只管 IO + 交互。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { i18n } from '@/i18n';
import {
  APP_BINARY_VERSION,
  IS_OTA_SELFHOST,
  IS_TESTFLIGHT_BUILD,
  REVIEW_MODE,
} from '@/config/env';
import { fetchLatestRelease } from './fetchLatestRelease';
import {
  evaluateBundleUpdate,
  preferredInstallUrl,
  shouldCheckBundleUpdate,
} from './bundleUpdate';
import type { BundleUpdateCheckOutcome } from './manualUpdateCheck';
import { enterForcedUpdate } from './forcedUpdateStore';
import { resolveUpdateChannelForDevice } from './canaryChannelStore';
import type { UpdateChannel } from '@cindy/maker-shared/update-channel';

type CheckState = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error';

interface Options {
  /** 挂载时自动检查一次(启动路径用 true;设置页用 false,只手动触发)。 */
  auto?: boolean;
  /** 无更新时是否提示(设置页手动检查用 true,启动静默用 false)。 */
  notifyWhenUpToDate?: boolean;
  /** 自建更新通道；缺省读取启动时已 hydrate 的本地快照(canary+beta 收敛)。 */
  channel?: UpdateChannel;
}

async function openInstall(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
    // itms-services 安装全程由 iOS 系统接管:App 内没有任何回调/进度 UI,唯一反馈是
    // 桌面图标上的进度环。不提示的话用户点完"安装"会以为没反应(平台限制,无法在
    // App 内展示进度),所以这里补一句引导;Android 走 APK 下载页,不需要这条提示。
    // 注意 openURL 在系统接下 URL 时即 resolve,早于用户在系统弹框里点「安装/取消」,
    // 无法得知用户的选择,措辞必须是条件引导式,不能断言"安装已开始"。
    if (url.startsWith('itms-services://')) {
      Alert.alert(i18n.t('update.installHintTitle'), i18n.t('update.installHintBody'));
    }
  } catch {
    Alert.alert(i18n.t('update.openInstallFailedTitle'), i18n.t('update.openInstallFailedBody'));
  }
}

/** 阻断屏的「去更新」出口:解析安装地址并交给系统。无可用地址则 no-op。 */
export function openBundleInstall(target: { itmsUrl?: string; installUrl?: string }): void {
  const url = preferredInstallUrl(target);
  if (url) void openInstall(url);
}

/**
 * 整包更新的统一出口。启动/设置页检查与 resume 静默检查共用。
 * - 强更:不弹窗,进入模块级阻断态,由 root 层渲染只有「去更新」的闸门屏。
 *   弹窗做不到阻断——RN Alert 的按钮点一下就关(cancelable: false 只挡点外部/返回键),
 *   弹窗消失后底下的 App 照旧可用,那是"强提醒"不是"强制"。
 * - 非强更:可跳过的普通提示,行为不变。
 * 两种情况都要求先解析出可跳转的安装地址:拿不到地址就什么都不做,
 * 尤其不能把用户关进一个没有出口的阻断屏(见 forcedUpdateStore 的三层保证)。
 */
export function promptBundleUpdate(evaluation: ReturnType<typeof evaluateBundleUpdate>): void {
  if (!evaluation.target) return;
  const url = preferredInstallUrl(evaluation.target);
  if (!url) return;

  if (evaluation.forced) {
    enterForcedUpdate(evaluation.target);
    return;
  }

  const notes = evaluation.target.releaseNotes?.trim();
  const message = [
    i18n.t('update.bundleAvailableBody'),
    notes ? i18n.t('update.releaseNotes', { notes }) : '',
  ].join('');
  Alert.alert(i18n.t('update.newVersionTitle'), message, [
    { text: i18n.t('update.later'), style: 'cancel' },
    { text: i18n.t('update.goUpdate'), onPress: () => void openInstall(url) },
  ]);
}

export function useBundleUpdatePrompt({
  auto = true,
  notifyWhenUpToDate = false,
  channel = resolveUpdateChannelForDevice(),
}: Options = {}) {
  const [state, setState] = useState<CheckState>('idle');
  const bundleCheckEnabled = shouldCheckBundleUpdate({
    isSelfHosted: IS_OTA_SELFHOST,
    isReviewMode: REVIEW_MODE,
    isTestFlightBuild: IS_TESTFLIGHT_BUILD,
  });
  const inFlightChannels = useRef(new Set<UpdateChannel>());
  const channelEpochRef = useRef(0);
  const previousChannelRef = useRef(channel);
  // render 已经是 channel 切换对本 hook 可见的最早时点；在这里递增 epoch，
  // 让旧账号请求即使恰好晚返回，也不能更新新账号的 UI。
  if (previousChannelRef.current !== channel) {
    previousChannelRef.current = channel;
    channelEpochRef.current += 1;
  }

  const checkNow = useCallback(async (): Promise<BundleUpdateCheckOutcome> => {
    // 审核模式与 TestFlight 都禁止整包外跳；这里再挡一层，不依赖调用方记得隐藏入口。
    if (!bundleCheckEnabled) return 'skipped';
    if (inFlightChannels.current.has(channel)) return 'busy';
    inFlightChannels.current.add(channel);
    const requestEpoch = channelEpochRef.current;
    setState('checking');
    try {
      // 平台化:iOS 读 mobile-ota/ios/release.json、Android 读 mobile-ota/android/release.json
      // (整包记录按平台分目录;iOS 走 itms、Android 走 APK 直下,preferredInstallUrl 已自动回退)。
      const latest = await fetchLatestRelease(
        Platform.OS === 'android' ? 'android' : 'ios',
        undefined,
        undefined,
        channel,
      );
      if (requestEpoch !== channelEpochRef.current) return 'skipped';
      const evaluation = evaluateBundleUpdate({
        currentRuntimeVersion: Updates.runtimeVersion,
        // 强更门槛(minVersion)按原生真值比,避免热更后 expoConfig.version 被内嵌旧值
        // 覆盖导致原生已达标的机器被误判为低于门槛、错误触发强更。
        currentVersion: APP_BINARY_VERSION || null,
        latest,
      });
      if (evaluation.needsUpdate) {
        setState('update-available');
        promptBundleUpdate(evaluation);
        return 'update-available';
      } else {
        setState('up-to-date');
        if (notifyWhenUpToDate) Alert.alert(i18n.t('update.upToDateTitle'), i18n.t('update.upToDateBody'));
        return 'up-to-date';
      }
    } catch {
      if (requestEpoch !== channelEpochRef.current) return 'skipped';
      // fetchLatestRelease 连不上(网络/超时/5xx)时抛错:自动检查静默(尽力而为),
      // 手动检查须提示"检查失败",不能沿用旧行为误报"已是最新"。
      setState('error');
      if (notifyWhenUpToDate) Alert.alert(i18n.t('update.checkFailedTitle'), i18n.t('update.checkFailedBody'));
      return 'error';
    } finally {
      inFlightChannels.current.delete(channel);
    }
  }, [bundleCheckEnabled, channel, notifyWhenUpToDate]);

  useEffect(() => {
    if (auto && bundleCheckEnabled) void checkNow();
    // auto hook 在登录/切账号导致 channel 变化时再检查一次，避免新的账号
    // 继续沿用旧账号的 release 指针；手动检查入口仍由调用方通过 checkNow 触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, bundleCheckEnabled, channel]);

  return { state, checkNow };
}
