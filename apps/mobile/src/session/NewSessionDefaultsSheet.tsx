/**
 * Android「新建任务默认」弹窗：分「在应用内新建」「从桌面小组件新建」两份档案，
 * 每份设置默认电脑与默认工作区。
 *
 * 交互：点一行在同一弹窗内进入二级选择；选中即保存（无保存按钮）；「跟随上次」
 * 的完整顺序放在底部可展开说明里。具体项目只存在于一台电脑上，选项目会同时把
 * 该档案的电脑钉到项目所在电脑。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderPlus,
  Laptop,
  MessageCircle,
} from 'lucide-react-native';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Text } from '@/components/AppText';
import { deviceDisplayName } from '@/device-link/deviceName';
import {
  createMobileMakerTransport,
  type RemoteDirectoryListResult,
} from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  buildRecentWorkspaceOptions,
  filterRemoteDirectoryEntries,
  normalizeRemoteDirectoryDrives,
  shouldRetryRemoteBrowseDrives,
  type NewSessionDeviceOption,
  type NewSessionStoredPreferences,
  type RecentWorkspaceOption,
} from '@/session/newSession';
import type { RemoteSession } from '@/session/types';
import {
  newSessionDefaultProfileForOrigin,
  newSessionDefaultProjectName,
  resolveNewSessionDefaultDevice,
  resolveNewSessionDefaultWorkspace,
  withNewSessionDefaultDevice,
  withNewSessionDefaultProject,
  withNewSessionDefaultWorkspace,
  type NewSessionDefaultProfileKey,
  type NewSessionDefaults,
  type ResolvedNewSessionDefaultDevice,
  type ResolvedNewSessionDefaultWorkspace,
} from '@/session/newSessionDefaults';
import type { NewSessionOrigin } from '@/session/newSessionOrigin';
import { newSessionText } from '@/session/newSessionMessages';
import { ContextSheetFooterButton, ContextSheetGroup, ContextSheetNote, ContextSheetRow } from './ContextSheet';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from './contextSheetModel';
import { NewTaskSelectionRow } from './NewTaskSelectionRow';
import { SheetModal } from './SheetModal';
import { SheetSurface } from './SheetSurface';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';

type Page =
  | { kind: 'main' }
  | { kind: 'device'; profile: NewSessionDefaultProfileKey }
  | { kind: 'workspace'; profile: NewSessionDefaultProfileKey }
  | { kind: 'directory'; profile: NewSessionDefaultProfileKey; deviceId: string; deviceName: string };

export function NewSessionDefaultsSheet({
  visible,
  onClose,
  defaults,
  deviceOptions,
  preferences,
  rememberedDeviceId,
  routeDevice,
  sessions,
  currentOrigin,
  currentUntouched,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  defaults: NewSessionDefaults;
  deviceOptions: readonly NewSessionDeviceOption[];
  preferences: NewSessionStoredPreferences | null;
  rememberedDeviceId: string | null;
  routeDevice: NewSessionDeviceOption | null;
  /** 父页同一份会话快照；避免弹窗再订阅一次会话 store。 */
  sessions: readonly RemoteSession[];
  currentOrigin: NewSessionOrigin;
  currentUntouched: boolean;
  onSave: (next: NewSessionDefaults) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { invoke, openLink } = useDeviceLink();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [page, setPage] = useState<Page>({ kind: 'main' });
  const [explainOpen, setExplainOpen] = useState(false);
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  const [showHidden, setShowHidden] = useState(false);
  const [directory, setDirectory] = useState<RemoteDirectoryListResult | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const directorySeq = useRef(0);
  const browsing = page.kind === 'directory';
  const heights = useMemo(
    () => computeContextSheetSnapHeights({ screenHeight: height, safeAreaTopInset: insets.top }),
    [height, insets.top],
  );

  useEffect(() => {
    if (!visible) {
      directorySeq.current += 1;
      return;
    }
    setPage({ kind: 'main' });
    setExplainOpen(false);
    setShowHidden(false);
    setDirectory(null);
    setDirectoryError(null);
    setDirectoryLoading(false);
    setSnap('half');
  }, [visible]);

  useEffect(() => {
    setSnap(browsing ? 'full' : 'half');
  }, [browsing]);

  const profile = page.kind === 'main' ? null : page.profile;

  const resolveDevice = useCallback(
    (target: NewSessionDefaultProfileKey): ResolvedNewSessionDefaultDevice => resolveNewSessionDefaultDevice({
      defaults,
      profile: target,
      deviceOptions,
      rememberedDeviceId,
      // 组件入口没有路由电脑；应用内预览仍可把首页带来的电脑当第一台可用。
      routeDevice: target === 'widget' ? null : routeDevice,
      // 设置页展示的是「默认」，不把当前入口的显式目标算进来。
      routeDeviceExplicit: false,
    }),
    [defaults, deviceOptions, rememberedDeviceId, routeDevice],
  );

  const recentFor = useCallback(
    (deviceId: string | undefined): readonly RecentWorkspaceOption[] => (visible && deviceId
      ? buildRecentWorkspaceOptions(
        sessions.filter((session) => session.deviceLinkDeviceId === deviceId),
        deviceId,
        6,
      )
      : []),
    [sessions, visible],
  );

  const resolveWorkspace = useCallback(
    (target: NewSessionDefaultProfileKey, deviceId: string | undefined): ResolvedNewSessionDefaultWorkspace => {
      const recentWorkspaces = recentFor(deviceId);
      return resolveNewSessionDefaultWorkspace({
        defaults,
        profile: target,
        deviceId: deviceId ?? '',
        followLastKind: preferences?.workspaceKind ?? null,
        initialKind: 'dialogue',
        rememberedWorkingDir: deviceId ? preferences?.workingDirByDevice?.[deviceId] ?? null : null,
        recentWorkspaces,
      });
    },
    [defaults, preferences, recentFor],
  );

  const appDevice = resolveDevice('app');
  const widgetDevice = resolveDevice('widget');
  const appWorkspace = resolveWorkspace('app', appDevice.device?.deviceId);
  const widgetWorkspace = resolveWorkspace('widget', widgetDevice.device?.deviceId);

  const deviceResolution = (target: NewSessionDefaultProfileKey) =>
    target === 'app' ? appDevice : widgetDevice;
  const workspaceResolution = (target: NewSessionDefaultProfileKey) =>
    target === 'app' ? appWorkspace : widgetWorkspace;

  const profileDeviceChoice = (target: NewSessionDefaultProfileKey) => defaults[target].device;
  const profileWorkspaceChoice = (target: NewSessionDefaultProfileKey) => defaults[target].workspace;

  const deviceChoiceLabel = (target: NewSessionDefaultProfileKey): string => {
    const choice = profileDeviceChoice(target);
    if (choice.kind === 'follow-app') return t('session.new.defaults.followApp');
    if (choice.kind === 'follow-last') return t('session.new.defaults.followLast');
    return deviceDisplayName(choice.deviceId, choice.name, deviceOptions);
  };

  const deviceChoiceDetail = (target: NewSessionDefaultProfileKey): string | undefined => {
    const resolution = deviceResolution(target);
    const choice = profileDeviceChoice(target);
    if (resolution.unavailable) return t('session.new.defaults.unavailable');
    if (!resolution.device) return t('session.new.defaults.noDevice');
    if (choice.kind !== 'device') {
      return t('session.new.defaults.effective', {
        value: deviceDisplayName(resolution.device.deviceId, resolution.device.name, deviceOptions),
      });
    }
    return undefined;
  };

  const workspaceChoiceLabel = (target: NewSessionDefaultProfileKey): string => {
    const choice = profileWorkspaceChoice(target);
    if (choice.kind === 'follow-app') return t('session.new.defaults.followApp');
    if (choice.kind === 'follow-last') return t('session.new.defaults.followLast');
    if (choice.kind === 'dialogue') return t('session.new.defaults.dialogue');
    return newSessionDefaultProjectName(choice.workingDir);
  };

  const workspaceChoiceDetail = (target: NewSessionDefaultProfileKey): string | undefined => {
    const resolution = workspaceResolution(target);
    const choice = profileWorkspaceChoice(target);
    if (choice.kind === 'project') {
      if (resolution.unavailableDefault) return t('session.new.defaults.unavailable');
      return choice.workingDir;
    }
    if (resolution.kind === 'dialogue') return t('session.new.defaults.effective', { value: t('session.new.defaults.dialogue') });
    if (resolution.kind === 'project') {
      return t('session.new.defaults.effective', {
        value: resolution.workingDir
          ? newSessionDefaultProjectName(resolution.workingDir)
          : t('session.new.defaults.noProject'),
      });
    }
    return undefined;
  };

  const selectDevice = (
    target: NewSessionDefaultProfileKey,
    device: NewSessionDefaults['app']['device'],
  ) => {
    const next = withNewSessionDefaultDevice(defaults, target, device);
    onSave(next);
    setPage({ kind: 'main' });
  };

  const selectWorkspace = (
    target: NewSessionDefaultProfileKey,
    workspace: NewSessionDefaults['app']['workspace'],
  ) => {
    onSave(withNewSessionDefaultWorkspace(defaults, target, workspace));
    setPage({ kind: 'main' });
  };

  const selectProject = (
    target: NewSessionDefaultProfileKey,
    workingDir: string,
    device = deviceResolution(target).device,
  ) => {
    if (!device) return;
    onSave(withNewSessionDefaultProject(defaults, target, device, workingDir));
    setPage({ kind: 'main' });
  };

  const loadDirectory = useCallback(async (
    deviceId: string,
    path: string,
    seq: number,
  ) => {
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      await openLink(deviceId);
      const maker = createMobileMakerTransport({ deviceId, invoke });
      let result = await withTransientRemoteRetry(() => maker.fs.listDir(path.trim() || '~'));
      if (seq !== directorySeq.current) return;
      setDirectory(result);
      setDirectoryLoading(false);
      for (let attempt = 0; shouldRetryRemoteBrowseDrives(result.drivesPending, attempt); attempt += 1) {
        try {
          result = await maker.fs.listDir(result.resolvedPath);
        } catch {
          return;
        }
        if (seq !== directorySeq.current) return;
        setDirectory(result);
      }
    } catch (error) {
      if (seq !== directorySeq.current) return;
      setDirectoryError(formatRemoteError(error));
      setDirectoryLoading(false);
    }
  }, [invoke, openLink]);

  const openDirectory = (target: NewSessionDefaultProfileKey) => {
    const device = deviceResolution(target).device;
    if (!device) return;
    const seq = ++directorySeq.current;
    setShowHidden(false);
    setDirectory(null);
    setDirectoryError(null);
    setPage({ kind: 'directory', profile: target, deviceId: device.deviceId, deviceName: device.name });
    void loadDirectory(device.deviceId, '~', seq);
  };

  const goBack = () => {
    if (page.kind === 'directory') {
      directorySeq.current += 1;
      setPage({ kind: 'workspace', profile: page.profile });
      return;
    }
    if (page.kind === 'device' || page.kind === 'workspace') {
      setPage({ kind: 'main' });
      return;
    }
    onClose();
  };

  const title = page.kind === 'main'
    ? t('session.new.defaults.title')
    : page.kind === 'device'
      ? t('session.new.defaults.devicePickerTitle')
      : page.kind === 'workspace'
        ? t('session.new.defaults.workspacePickerTitle')
        : t('session.new.defaults.chooseFolder');

  const currentDevice = page.kind === 'directory' ? { deviceId: page.deviceId, name: page.deviceName } : null;
  const profileForPage = profile;
  const workspaceDevice = profileForPage ? deviceResolution(profileForPage).device : null;
  const workspaceRecent = profileForPage && workspaceDevice
    ? recentFor(workspaceDevice.deviceId)
    : [];
  const workspaceChoice = profileForPage ? profileWorkspaceChoice(profileForPage) : null;
  const currentProfile = newSessionDefaultProfileForOrigin(currentOrigin);
  const applyHint = t(currentUntouched
    ? 'session.new.defaults.applyHintUntouched'
    : 'session.new.defaults.applyHintTouched');
  const appSectionHint = currentProfile === 'app'
    ? `${t('session.new.defaults.sectionAppHint')}\n${applyHint}`
    : t('session.new.defaults.sectionAppHint');
  const widgetSectionHint = currentProfile === 'widget'
    ? `${t('session.new.defaults.sectionWidgetHint')}\n${applyHint}`
    : t('session.new.defaults.sectionWidgetHint');
  const directoryEntries = filterRemoteDirectoryEntries(
    (directory?.entries ?? []).filter((entry) => entry.kind !== 'file'),
    showHidden,
  );
  const drives = normalizeRemoteDirectoryDrives(directory?.drives);
  const directoryPath = directory?.resolvedPath ?? '';

  return (
    <SheetModal
      visible={visible}
      onBackdropPress={onClose}
      onRequestClose={goBack}
      onClosed={() => {
        directorySeq.current += 1;
      }}
    >
      <SheetSurface
        bottomInset={insets.bottom}
        footer={browsing ? (
          <ContextSheetFooterButton
            disabled={directoryLoading || !directoryPath || !!directoryError}
            label={t('session.new.useCurrent')}
            onPress={() => {
              if (!profileForPage || !currentDevice || !directoryPath || directoryLoading || directoryError) return;
              selectProject(profileForPage, directoryPath, currentDevice);
            }}
            testID="newSession.defaults.useCurrentFolder"
          />
        ) : undefined}
        heights={heights}
        onBack={page.kind === 'main' ? undefined : goBack}
        onClose={onClose}
        onSnapChange={setSnap}
        snap={snap}
        testID="newSession.defaults.sheet"
        title={title}
      >
        {page.kind === 'main' ? (
          <>
            <ContextSheetGroup
              footer={appSectionHint}
              label={t('session.new.defaults.sectionApp')}
            >
              <ContextSheetRow
                accessibilityLabel={rowAccessibilityLabel(
                  t('session.new.defaults.deviceLabel'),
                  deviceChoiceLabel('app'),
                  deviceChoiceDetail('app'),
                )}
                detail={deviceChoiceDetail('app')}
                label={t('session.new.defaults.deviceLabel')}
                onPress={() => setPage({ kind: 'device', profile: 'app' })}
                testID="newSession.defaults.app.device"
                trailing="chevron"
                value={deviceChoiceLabel('app')}
              />
              <ContextSheetRow
                accessibilityLabel={rowAccessibilityLabel(
                  t('session.new.defaults.workspaceLabel'),
                  workspaceChoiceLabel('app'),
                  workspaceChoiceDetail('app'),
                )}
                detail={workspaceChoiceDetail('app')}
                detailLines={1}
                label={t('session.new.defaults.workspaceLabel')}
                onPress={() => setPage({ kind: 'workspace', profile: 'app' })}
                testID="newSession.defaults.app.workspace"
                trailing="chevron"
                value={workspaceChoiceLabel('app')}
              />
            </ContextSheetGroup>

            <ContextSheetGroup
              footer={widgetSectionHint}
              label={t('session.new.defaults.sectionWidget')}
            >
              <ContextSheetRow
                accessibilityLabel={rowAccessibilityLabel(
                  t('session.new.defaults.deviceLabel'),
                  deviceChoiceLabel('widget'),
                  deviceChoiceDetail('widget'),
                )}
                detail={deviceChoiceDetail('widget')}
                label={t('session.new.defaults.deviceLabel')}
                onPress={() => setPage({ kind: 'device', profile: 'widget' })}
                testID="newSession.defaults.widget.device"
                trailing="chevron"
                value={deviceChoiceLabel('widget')}
              />
              <ContextSheetRow
                accessibilityLabel={rowAccessibilityLabel(
                  t('session.new.defaults.workspaceLabel'),
                  workspaceChoiceLabel('widget'),
                  workspaceChoiceDetail('widget'),
                )}
                detail={workspaceChoiceDetail('widget')}
                detailLines={1}
                label={t('session.new.defaults.workspaceLabel')}
                onPress={() => setPage({ kind: 'workspace', profile: 'widget' })}
                testID="newSession.defaults.widget.workspace"
                trailing="chevron"
                value={workspaceChoiceLabel('widget')}
              />
            </ContextSheetGroup>

            <View style={styles.explain}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: explainOpen }}
                onPress={() => setExplainOpen((value) => !value)}
                style={({ pressed }) => [styles.explainHeader, pressed && styles.pressed]}
                testID="newSession.defaults.explanation"
              >
                <Text style={styles.explainTitle}>{t('session.new.defaults.explainTitle')}</Text>
                {explainOpen
                  ? <ChevronUp color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
                  : <ChevronDown color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
              </Pressable>
              {explainOpen ? (
                <View style={styles.explainBody}>
                  <Text style={styles.explainSectionTitle}>{t('session.new.defaults.explainDeviceTitle')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainDeviceEntry')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainDeviceRemembered')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainDeviceFallback')}</Text>
                  <Text style={styles.explainSectionTitle}>{t('session.new.defaults.explainWorkspaceTitle')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainWorkspaceEntry')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainWorkspaceMode')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainWorkspaceProject')}</Text>
                  <Text style={styles.explainText}>{t('session.new.defaults.explainWidgetNote')}</Text>
                </View>
              ) : null}
            </View>

            <ContextSheetNote text={t('session.new.defaults.storageHint')} />
          </>
        ) : page.kind === 'device' ? (
          <>
            {page.profile === 'widget' ? (
              <NewTaskSelectionRow
                selected={defaults.widget.device.kind === 'follow-app'}
                subtitle={t('session.new.defaults.followAppHint')}
                title={t('session.new.defaults.followApp')}
                onPress={() => selectDevice('widget', { kind: 'follow-app' })}
                testID="newSession.defaults.device.followApp"
              />
            ) : null}
            <NewTaskSelectionRow
              selected={defaults[page.profile].device.kind === 'follow-last'}
              subtitle={t('session.new.defaults.followLastDeviceHint')}
              title={t('session.new.defaults.followLast')}
              onPress={() => selectDevice(page.profile, { kind: 'follow-last' })}
              testID="newSession.defaults.device.followLast"
            />
            {deviceOptions.map((device) => {
              const choice = defaults[page.profile].device;
              const selected = choice.kind === 'device' && choice.deviceId === device.deviceId;
              return (
                <NewTaskSelectionRow
                  key={device.deviceId}
                  leading={<Laptop color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  selected={selected}
                  title={deviceDisplayName(device.deviceId, device.name, deviceOptions)}
                  onPress={() => selectDevice(page.profile, {
                    kind: 'device',
                    deviceId: device.deviceId,
                    name: device.name,
                  })}
                  testID="newSession.defaults.deviceOption"
                />
              );
            })}
            {(() => {
              const choice = defaults[page.profile].device;
              if (choice.kind !== 'device') return null;
              if (deviceOptions.some((device) => device.deviceId === choice.deviceId)) return null;
              return (
                <NewTaskSelectionRow
                  disabled
                  selected
                  subtitle={t('session.new.defaults.unavailable')}
                  title={deviceDisplayName(choice.deviceId, choice.name, deviceOptions)}
                  onPress={() => undefined}
                  testID="newSession.defaults.deviceUnavailable"
                />
              );
            })()}
          </>
        ) : page.kind === 'workspace' ? (
          <>
            <ContextSheetNote
              text={t('session.new.defaults.onComputer', {
                device: workspaceDevice
                  ? deviceDisplayName(workspaceDevice.deviceId, workspaceDevice.name, deviceOptions)
                  : t('session.new.defaults.noDevice'),
              })}
            />
            {page.profile === 'widget' ? (
              <NewTaskSelectionRow
                selected={defaults.widget.workspace.kind === 'follow-app'}
                subtitle={t('session.new.defaults.followAppHint')}
                title={t('session.new.defaults.followApp')}
                onPress={() => selectWorkspace('widget', { kind: 'follow-app' })}
                testID="newSession.defaults.workspace.followApp"
              />
            ) : null}
            <NewTaskSelectionRow
              selected={defaults[page.profile].workspace.kind === 'follow-last'}
              subtitle={t('session.new.defaults.followLastWorkspaceHint')}
              title={t('session.new.defaults.followLast')}
              onPress={() => selectWorkspace(page.profile, { kind: 'follow-last' })}
              testID="newSession.defaults.workspace.followLast"
            />
            <NewTaskSelectionRow
              leading={<MessageCircle color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
              selected={defaults[page.profile].workspace.kind === 'dialogue'}
              title={t('session.new.defaults.dialogue')}
              onPress={() => selectWorkspace(page.profile, { kind: 'dialogue' })}
              testID="newSession.defaults.workspace.dialogue"
            />
            {workspaceChoice?.kind === 'project'
              && !workspaceRecent.some((workspace) => workspace.workingDir === workspaceChoice.workingDir) ? (
                <NewTaskSelectionRow
                  leading={<Folder color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  selected
                  subtitle={workspaceChoice.workingDir}
                  title={newSessionDefaultProjectName(workspaceChoice.workingDir)}
                  onPress={() => {
                    if (workspaceChoice?.kind === 'project') {
                      selectProject(page.profile, workspaceChoice.workingDir);
                    }
                  }}
                  testID="newSession.defaults.workspaceStoredProject"
                />
              ) : null}
            {workspaceRecent.map((workspace) => (
              <NewTaskSelectionRow
                key={workspace.workingDir}
                leading={<Folder color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                selected={workspaceChoice?.kind === 'project' && workspaceChoice.workingDir === workspace.workingDir}
                subtitle={workspace.workingDir}
                title={workspace.title}
                onPress={() => selectProject(page.profile, workspace.workingDir)}
                testID="newSession.defaults.workspaceProject"
              />
            ))}
            {workspaceRecent.length === 0 && workspaceChoice?.kind !== 'project' ? (
              <ContextSheetNote text={t('session.new.defaults.noRecentProject')} />
            ) : null}
            <NewTaskSelectionRow
              disabled={!workspaceDevice}
              leading={<FolderPlus color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
              title={t('session.new.defaults.chooseFolder')}
              trailing={<ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
              onPress={() => openDirectory(page.profile)}
              testID="newSession.defaults.workspaceBrowse"
            />
          </>
        ) : (
          <>
            <Text numberOfLines={1} style={styles.directoryPath} testID="newSession.defaults.directoryPath">
              {directoryPath || t('session.new.readingRemoteDir')}
            </Text>
            {currentDevice ? (
              <ContextSheetNote text={t('session.new.defaults.onComputer', {
                device: deviceDisplayName(currentDevice.deviceId, currentDevice.name, deviceOptions),
              })} />
            ) : null}
            {directoryLoading ? <ActivityIndicator color={colors.textSecondary} /> : null}
            {directoryError ? <ErrorNotice message={directoryError} /> : null}
            {directory?.parent ? (
              <NewTaskSelectionRow
                leading={<ArrowUp color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                title={t('session.new.parentDir')}
                onPress={() => {
                  if (!directory?.parent) return;
                  void loadDirectory(page.deviceId, directory.parent, ++directorySeq.current);
                }}
                testID="newSession.defaults.directoryParent"
              />
            ) : null}
            {drives.map((drive) => (
              <NewTaskSelectionRow
                key={drive.path}
                selected={drive.current}
                title={drive.name}
                onPress={() => void loadDirectory(page.deviceId, drive.path, ++directorySeq.current)}
                testID="newSession.defaults.directoryDrive"
              />
            ))}
            {directoryEntries.map((entry) => (
              <NewTaskSelectionRow
                key={entry.path}
                leading={<Folder color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                title={entry.name}
                onPress={() => void loadDirectory(page.deviceId, entry.path, ++directorySeq.current)}
                testID="newSession.defaults.directoryEntry"
              />
            ))}
            <NewTaskSelectionRow
              selected={showHidden}
              title={newSessionText('showHiddenDirectories')}
              onPress={() => setShowHidden((value) => !value)}
              testID="newSession.defaults.directoryShowHidden"
            />
            {!directoryLoading && !directoryError && directoryEntries.length === 0 ? (
              <ContextSheetNote text={newSessionText('emptyDirectory')} />
            ) : null}
          </>
        )}
      </SheetSurface>
    </SheetModal>
  );
}

function rowAccessibilityLabel(label: string, value: string, detail: string | undefined): string {
  return [label, value, detail].filter(Boolean).join(', ');
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  explain: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.lg,
    paddingTop: spacing.sm,
  },
  explainHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  explainTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  explainBody: {
    paddingBottom: spacing.sm,
  },
  explainSectionTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  explainText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    marginBottom: spacing.xs,
  },
  directoryPath: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    paddingVertical: spacing.sm,
  },
  pressed: {
    opacity: 0.6,
  },
});
