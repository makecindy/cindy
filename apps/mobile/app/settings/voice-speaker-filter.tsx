import { useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { isClassicalLocale, modernLocaleOf } from '@/i18n/locale';
import { Check } from 'lucide-react-native';
import {
  SPEAKER_ENROLLMENT_CLIP_COUNT,
  SPEAKER_ENROLLMENT_MAX_CLIP_SEC,
  SPEAKER_GATE_STRICTNESS_VALUES,
  type SpeakerGateStrictness,
} from '@cindy/voice-input-core';

import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowOptionButton } from '@/components/MobilePrimitives';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import {
  ActionInfoRow,
  InfoRow,
  SettingsGroup,
  SettingsSwitchRow,
  useSettingsRowStyles,
} from '@/session/SettingsGroupRows';
import {
  cancelMobileSpeakerModelDownload,
  deleteMobileSpeakerProfile,
  downloadMobileSpeakerModels,
  enrollMobileSpeaker,
  getMobileSpeakerFilterSnapshot,
  hydrateMobileSpeakerFilter,
  setMobileSpeakerFilterEnabled,
  setMobileSpeakerFilterStrictness,
  subscribeMobileSpeakerFilter,
  type MobileSpeakerFilterSnapshot,
} from '@/session/mobileSpeakerFilter';
import {
  MobileSpeakerEnrollmentAbortedError,
  MobileSpeakerEnrollmentNoAudioError,
  recordMobileSpeakerClip,
} from '@/session/mobileSpeakerEnrollmentRecorder';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

const CLIP_SECONDS = SPEAKER_ENROLLMENT_MAX_CLIP_SEC;
const CLIP_INDEXES = Array.from({ length: SPEAKER_ENROLLMENT_CLIP_COUNT }, (_, index) => index);

type EnrollErrorKey =
  | 'too_short'
  | 'no_embedding'
  | 'inconsistent'
  | 'models_missing'
  | 'storage_unavailable'
  | 'failed'
  | 'microphone'
  | 'noAudio';

/**
 * 「识别我的声音」(设置的二级页)。
 *
 * 开关第一次打开时下载识别模型;模型就绪后朗读三段文字录入声纹;录好后可调灵敏度。
 * 声纹只存在这台手机(系统钥匙串 / Keystore),按账号分开,不同步、不上传。
 * 任一条件不满足时语音输入照常工作,只是不过滤。
 *
 * SettingsGroup 按直接子元素画分隔线,所以每组的行都以带 key 的数组给出,不包 Fragment。
 */
const liveServices = {
  cancelMobileSpeakerModelDownload, deleteMobileSpeakerProfile, downloadMobileSpeakerModels,
  enrollMobileSpeaker, getMobileSpeakerFilterSnapshot, hydrateMobileSpeakerFilter,
  setMobileSpeakerFilterEnabled, setMobileSpeakerFilterStrictness, subscribeMobileSpeakerFilter,
};

export default function VoiceSpeakerFilterRoute() {
  // Explicit development fixture: real capture/UI, deterministic validation
  // failures. Never loads models or writes voiceprints to a user's account.
  const services: typeof liveServices = __DEV__ && MOBILE_VISUAL_MOCK_ENABLED
    && process.env.EXPO_PUBLIC_CINDY_SPEAKER_ENROLLMENT_SCENARIO === '1'
    ? require('@/debug/speakerEnrollmentScenario').speakerEnrollmentScenario : liveServices;
  return <VoiceSpeakerFilterScreen services={services} />;
}

export function VoiceSpeakerFilterScreen({ services = liveServices }: { services?: typeof liveServices }) {
  const {
    deleteMobileSpeakerProfile, enrollMobileSpeaker, getMobileSpeakerFilterSnapshot,
    hydrateMobileSpeakerFilter, setMobileSpeakerFilterEnabled, setMobileSpeakerFilterStrictness,
    subscribeMobileSpeakerFilter,
  } = services;
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  // The model covers Chinese and English; other UI locales use English passages.
  // Classical editions read their modern passages aloud.
  const modernLanguage = isClassicalLocale(language) ? modernLocaleOf(language) : language;
  const passageLanguage = modernLanguage === 'zh-CN' || modernLanguage === 'zh-TW' ? modernLanguage : 'en';
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const state = useSyncExternalStore(subscribeMobileSpeakerFilter, getMobileSpeakerFilterSnapshot);

  const [enrolling, setEnrolling] = useState(false);
  const [clips, setClips] = useState<Array<ArrayBuffer | null>>(() => CLIP_INDEXES.map(() => null));
  const [current, setCurrent] = useState(0);
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [enrollError, setEnrollError] = useState<{ key: EnrollErrorKey; clipIndex?: number } | null>(null);
  const [retryIndex, setRetryIndex] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const passageRef = useRef<View>(null);
  const scrollOffset = useRef(0);
  const revealFrame = useRef<number | null>(null);
  const revealGeneration = useRef(0);
  const headerHeight = useHeaderHeight();
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const reportActionFailure = useCallback(() => {
    Alert.alert(t('settings.voiceSpeakerFilter.actionFailed'));
  }, [t]);

  useEffect(() => {
    void hydrateMobileSpeakerFilter();
  }, []);

  // Never leave the microphone open behind a closed screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Measure the committed native layout, including iOS's transparent navigation
  // bar. Only move an off-screen passage; recording updates must not move it.
  const revealPassage = useCallback(() => {
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    const generation = ++revealGeneration.current;
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = null;
      scrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, viewportY, _width, viewportHeight) => {
        passageRef.current?.measureInWindow((_px, passageY, _pw, passageHeight) => {
          if (generation !== revealGeneration.current || passageHeight <= 0) return;
          const top = Math.max(viewportY, Platform.OS === 'ios' ? headerHeight : viewportY) + spacing.lg;
          const bottom = viewportY + viewportHeight - spacing.lg;
          if (passageY >= top && passageY + passageHeight <= bottom) return;
          scrollRef.current?.scrollTo({
            y: Math.max(Platform.OS === 'ios' ? -headerHeight : 0, scrollOffset.current + passageY - top),
            animated: false,
          });
        });
      });
    });
  }, [headerHeight]);

  useEffect(() => {
    if (enrolling && !recording) revealPassage();
    return () => {
      revealGeneration.current += 1;
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    };
  }, [current, enrolling, enrollError, recording, revealPassage]);

  const resetEnrollment = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopRef.current = null;
    setClips(CLIP_INDEXES.map(() => null));
    setCurrent(0);
    setRecording(false);
    setProgress(0);
    setSaving(false);
    setEnrollError(null);
    setRetryIndex(null);
  }, []);

  const record = useCallback(async () => {
    if (abortRef.current || recording || saving) return;
    setEnrollError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const stopController = new AbortController();
    stopRef.current = stopController;
    const index = current;
    setRecording(true);
    setProgress(0);
    try {
      const clip = await recordMobileSpeakerClip({
        durationMs: CLIP_SECONDS * 1000,
        onProgress: (fraction) => {
          if (abortRef.current === controller && !controller.signal.aborted) setProgress(fraction);
        },
        signal: controller.signal,
        stopSignal: stopController.signal,
      });
      if (abortRef.current !== controller || controller.signal.aborted) return;
      const next = [...clipsRef.current];
      next[index] = clip;
      setClips(next);
      setRetryIndex((previous) => previous === index ? null : previous);
      const nextEmpty = CLIP_INDEXES.find((candidate) => !next[candidate]);
      if (nextEmpty !== undefined) setCurrent(nextEmpty);
    } catch (error) {
      if (abortRef.current !== controller || error instanceof MobileSpeakerEnrollmentAbortedError) return;
      // A denied permission and a failing device both mean "check the microphone".
      setEnrollError({ key: error instanceof MobileSpeakerEnrollmentNoAudioError ? 'noAudio' : 'microphone' });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        stopRef.current = null;
        setRecording(false);
      }
    }
  }, [current, recording, saving]);

  const submit = useCallback(async () => {
    if (!clips.every((clip) => clip !== null) || saving || recording) return;
    setSaving(true);
    setEnrollError(null);
    const result = await enrollMobileSpeaker(clips as ArrayBuffer[]);
    setSaving(false);
    if (result.ok) {
      resetEnrollment();
      setEnrolling(false);
      return;
    }
    setEnrollError({ key: result.reason, clipIndex: result.clipIndex });
    if (result.clipIndex !== undefined) {
      const redo = result.clipIndex;
      setRetryIndex(redo);
      setClips((previous) => previous.map((clip, index) => (index === redo ? null : clip)));
      setCurrent(redo);
    }
  }, [clips, recording, resetEnrollment, saving]);

  const confirmDelete = useCallback(() => {
    Alert.alert(
      t('settings.voiceSpeakerFilter.profile.deleteConfirm.title'),
      t('settings.voiceSpeakerFilter.profile.deleteConfirm.description'),
      [
        { text: t('settings.voiceSpeakerFilter.profile.deleteConfirm.cancel'), style: 'cancel' },
        {
          text: t('settings.voiceSpeakerFilter.profile.deleteConfirm.confirm'),
          style: 'destructive',
          onPress: () => {
            void deleteMobileSpeakerProfile().catch(reportActionFailure);
          },
        },
      ],
    );
  }, [reportActionFailure, t]);

  const showDetails = state.supported && state.hydrated && (state.enabled || state.enrolled);
  const modelsReady = state.modelState === 'ready';
  const allRecorded = clips.every((clip) => clip !== null);
  const recordLabel = t(recording
    ? 'settings.voiceSpeakerFilter.enroll.stop'
    : clips[current] || retryIndex === current
      ? 'settings.voiceSpeakerFilter.enroll.rerecordStep'
      : 'settings.voiceSpeakerFilter.enroll.record', { index: current + 1 });
  const visibleError = enrollError && (enrollError.clipIndex === undefined || enrollError.clipIndex === current)
    ? enrollError : null;

  const deleteRow = (
    <ActionInfoRow
      key="delete"
      accessibilityLabel={t('settings.voiceSpeakerFilter.profile.delete')}
      label={t('settings.voiceSpeakerFilter.profile.delete')}
      onPress={confirmDelete}
      testID="settings.voiceSpeakerFilter.profile.delete"
    />
  );

  const enrollmentRows: ReactNode[] = [
    <View key="reader" style={[rowStyles.row, styles.reader]}>
      <View style={styles.steps}>
        {CLIP_INDEXES.map((index) => {
          const status = recording && index === current ? 'recording'
            : retryIndex === index ? 'retry' : clips[index] ? 'recorded' : 'pending';
          const label = t('settings.voiceSpeakerFilter.enroll.stepChoice', {
            index: index + 1,
            status: t(`settings.voiceSpeakerFilter.enroll.stepStatus.${status}`),
          });
          return (
            <View key={index} style={styles.step}>
              <MainWindowOptionButton
                density="default"
                label={String(index + 1)}
                accessibilityLabel={label}
                selected={index === current}
                disabled={recording || saving}
                onPress={() => setCurrent(index)}
                style={styles.stepButton}
                testID={`settings.voiceSpeakerFilter.enroll.step.${index}`}
              />
              <Text style={styles.stepStatus}>{t(`settings.voiceSpeakerFilter.enroll.stepStatus.${status}`)}</Text>
            </View>
          );
        })}
      </View>
      <View ref={passageRef} collapsable={false} onLayout={revealPassage} style={styles.passageBlock}>
        <Text style={styles.passageTitle}>
          {t('settings.voiceSpeakerFilter.enroll.step', { current: current + 1, total: SPEAKER_ENROLLMENT_CLIP_COUNT })}
        </Text>
        <Text style={styles.passage} testID="settings.voiceSpeakerFilter.enroll.passage">
          {t(`settings.voiceSpeakerFilter.enroll.passages.p${current + 1}`, { lng: passageLanguage })}
        </Text>
      </View>
      <View style={styles.status} testID="settings.voiceSpeakerFilter.enroll.status">
        <Text accessibilityRole={visibleError ? 'alert' : undefined} style={rowStyles.rowDetail}>
          {recording
            ? t('settings.voiceSpeakerFilter.enroll.recording', { seconds: Math.max(0, Math.ceil(CLIP_SECONDS * (1 - progress))) })
            : saving ? t('settings.voiceSpeakerFilter.enroll.saving')
              : visibleError ? t(`settings.voiceSpeakerFilter.enroll.errors.${visibleError.key}`, { index: (visibleError.clipIndex ?? 0) + 1 })
                : t('settings.voiceSpeakerFilter.enroll.readHint')}
        </Text>
        {visibleError?.clipIndex !== undefined && clips.some(Boolean) ? (
          <Text style={rowStyles.rowDetail}>{t('settings.voiceSpeakerFilter.enroll.otherClipsKept')}</Text>
        ) : null}
      </View>
      <MainWindowActionButton action={{
        label: recordLabel,
        disabled: saving || (recording && progress === 0),
        tone: allRecorded && !recording ? 'secondary' : 'primary',
        onPress: () => {
          if (recording) stopRef.current?.abort();
          else void record();
        },
        testID: 'settings.voiceSpeakerFilter.enroll.record',
      }} />
    </View>,
    <View key="submit" style={rowStyles.row}>
      <MainWindowActionButton action={{
        label: t('settings.voiceSpeakerFilter.enroll.submit'),
        disabled: !allRecorded || recording || saving,
        busy: saving,
        tone: allRecorded && !recording ? 'primary' : 'secondary',
        onPress: () => { void submit(); },
        testID: 'settings.voiceSpeakerFilter.enroll.submit',
      }} />
    </View>,
    <ActionInfoRow
      key="cancel"
      accessibilityLabel={t('settings.voiceSpeakerFilter.enroll.cancel')}
      disabled={saving}
      label={t('settings.voiceSpeakerFilter.enroll.cancel')}
      onPress={() => {
        resetEnrollment();
        setEnrolling(false);
      }}
      testID="settings.voiceSpeakerFilter.enroll.cancel"
    />,
  ];

  // 录入时说明写在分组下方;未录入时提示「录入后才生效」,已录入时录入日期作为行右侧取值。
  const profileFooter = enrolling
    ? t('settings.voiceSpeakerFilter.enroll.description', {
      clips: SPEAKER_ENROLLMENT_CLIP_COUNT,
      seconds: CLIP_SECONDS,
    })
    : state.enrolled ? null : t('settings.voiceSpeakerFilter.profile.missingHint');
  const profileRows: ReactNode[] = [
    <InfoRow
      key="status"
      label={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.enrolled'
        : 'settings.voiceSpeakerFilter.profile.missing')}
      testID="settings.voiceSpeakerFilter.profile.status"
      value={state.enrolled && state.enrolledAt
        ? t('settings.voiceSpeakerFilter.profile.enrolledAt', {
          date: new Date(state.enrolledAt).toLocaleDateString(),
        })
        : ''}
    />,
    <ActionInfoRow
      key="enroll"
      accessibilityLabel={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.reenroll'
        : 'settings.voiceSpeakerFilter.profile.enroll')}
      label={t(state.enrolled
        ? 'settings.voiceSpeakerFilter.profile.reenroll'
        : 'settings.voiceSpeakerFilter.profile.enroll')}
      onPress={() => {
        resetEnrollment();
        setEnrolling(true);
      }}
      testID="settings.voiceSpeakerFilter.profile.enroll"
    />,
    state.enrolled ? deleteRow : null,
  ];

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.voiceSpeakerFilter.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.voiceSpeakerFilter.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.voiceSpeakerFilter.title')}
      />
      <ScrollView ref={scrollRef} {...simpleScrollInsetProps}
        onScroll={(event) => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        contentContainerStyle={styles.content} testID="settings.voiceSpeakerFilter.scroll">
        <SettingsGroup footer={state.supported ? t('settings.voiceSpeakerFilter.hint') : t('settings.voiceSpeakerFilter.unsupported')}>
          <SettingsSwitchRow
            accessibilityLabel={t('settings.voiceSpeakerFilter.label')}
            disabled={!state.supported || !state.hydrated || saving}
            label={t('settings.voiceSpeakerFilter.label')}
            onValueChange={(value) => {
              if (!value) {
                resetEnrollment();
                setEnrolling(false);
              }
              void setMobileSpeakerFilterEnabled(value).catch(reportActionFailure);
            }}
            switchTestID="settings.voiceSpeakerFilter.toggle"
            testID="settings.voiceSpeakerFilter.toggleRow"
            value={state.enabled && state.supported}
          />
        </SettingsGroup>

        {showDetails && !modelsReady ? <ModelGroup state={state} /> : null}

        {showDetails && modelsReady ? (
          <SettingsGroup footer={profileFooter} title={t('settings.voiceSpeakerFilter.profile.title')}>
            {enrolling ? enrollmentRows : profileRows}
          </SettingsGroup>
        ) : null}

        {showDetails && !modelsReady && state.enrolled ? (
          <SettingsGroup title={t('settings.voiceSpeakerFilter.profile.title')}>
            {deleteRow}
          </SettingsGroup>
        ) : null}

        {showDetails && state.enrolled && !enrolling ? (
          <SettingsGroup
            footer={t('settings.voiceSpeakerFilter.strictness.hint')}
            title={t('settings.voiceSpeakerFilter.strictness.label')}
          >
            {[
              ...SPEAKER_GATE_STRICTNESS_VALUES.map((value) => (
                <StrictnessRow
                  key={value}
                  onPress={() => {
                    void setMobileSpeakerFilterStrictness(value).catch(reportActionFailure);
                  }}
                  selected={state.strictness === value}
                  value={value}
                />
              )),
              state.strictnessCustomized ? (
                <ActionInfoRow
                  key="restore"
                  accessibilityLabel={t('settings.voiceSpeakerFilter.strictness.restoreDefault')}
                  label={t('settings.voiceSpeakerFilter.strictness.restoreDefault')}
                  onPress={() => {
                    void setMobileSpeakerFilterStrictness(null).catch(reportActionFailure);
                  }}
                  testID="settings.voiceSpeakerFilter.strictness.restore"
                />
              ) : null,
            ]}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ModelGroup({ state }: { state: MobileSpeakerFilterSnapshot }) {
  const { t } = useTranslation();
  const total = formatMegabytes(state.totalBytes);
  // 下载进度、所需大小与失败原因都写在分组下方;卡片里只留可点的动作行。
  if (state.modelState === 'downloading') {
    return (
      <SettingsGroup
        footer={t('settings.voiceSpeakerFilter.model.downloading', {
          done: formatMegabytes(state.downloadedBytes),
          total,
        })}
        title={t('settings.voiceSpeakerFilter.model.title')}
      >
        <ActionInfoRow
          accessibilityLabel={t('settings.voiceSpeakerFilter.model.cancel')}
          chevron={false}
          label={t('settings.voiceSpeakerFilter.model.cancel')}
          onPress={cancelMobileSpeakerModelDownload}
          testID="settings.voiceSpeakerFilter.model.cancel"
        />
      </SettingsGroup>
    );
  }
  const failed = state.modelState === 'failed';
  return (
    <SettingsGroup
      footer={failed ? null : t('settings.voiceSpeakerFilter.model.needed', { size: total })}
      footerTestID="settings.voiceSpeakerFilter.model.footer"
      messages={[failed
        ? {
            text: t(`settings.voiceSpeakerFilter.model.failed.${state.downloadError ?? 'network'}`),
            testID: 'settings.voiceSpeakerFilter.model.failed',
          }
        : null]}
      title={t('settings.voiceSpeakerFilter.model.title')}
    >
      <ActionInfoRow
        accessibilityLabel={t(failed ? 'settings.voiceSpeakerFilter.model.retry' : 'settings.voiceSpeakerFilter.model.download')}
        chevron={false}
        label={t(failed ? 'settings.voiceSpeakerFilter.model.retry' : 'settings.voiceSpeakerFilter.model.download')}
        onPress={() => {
          void downloadMobileSpeakerModels();
        }}
        testID="settings.voiceSpeakerFilter.model.download"
      />
    </SettingsGroup>
  );
}

function StrictnessRow({
  onPress,
  selected,
  value,
}: {
  onPress(): void;
  selected: boolean;
  value: SpeakerGateStrictness;
}) {
  const { t } = useTranslation();
  const rowStyles = useSettingsRowStyles();
  const { colors } = useTheme();
  const label = t(`settings.voiceSpeakerFilter.strictness.options.${value}`);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
      testID={`settings.voiceSpeakerFilter.strictness.${value}`}
    >
      <View style={rowStyles.rowLine}>
        <Text style={rowStyles.rowLabel}>{label}</Text>
        {selected ? <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} /> : null}
      </View>
    </Pressable>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  reader: { gap: spacing.lg },
  steps: { flexDirection: 'row', gap: spacing.md },
  step: { flex: 1, minWidth: 0, gap: spacing.sm },
  stepButton: { alignSelf: 'stretch' },
  stepStatus: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, textAlign: 'center' },
  passageBlock: { gap: spacing.sm },
  passageTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  // Reading content is not a flexing label in a horizontal settings row.
  passage: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular },
  status: { gap: spacing.xs },
});
