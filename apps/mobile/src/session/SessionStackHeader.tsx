import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { Menu } from 'lucide-react-native';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { navigationChrome } from '@/theme/tokens';
import { useNavigationCallback } from '@/platform/chrome/useNavigationCallback';
import { useStableValue } from '@/utils/useStableValue';
import { reuseJsonSnapshot } from '@/utils/reuseJsonSnapshot';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import {
  SessionHeaderNativeActions, SessionHeaderNativeBack, SessionHeaderNativeTitle,
  type SessionHeaderNativeActionsProps, type SessionHeaderNativeTitleProps,
} from './SessionHeaderNativeControls';

type ActionsProps = Pick<SessionHeaderNativeActionsProps, 'available' | 'detailsOnly' | 'screen'> & {
  filesDisabled: boolean;
  filesDisabledReason?: string | null;
  onFiles(): void;
  onDetails(): void;
  onDesktop(): void;
};

/** Real toolbar buttons retain the system's side/bottom navigation adaptation. */
export function SessionStackActions({ available, detailsOnly, screen, filesDisabled,
  onFiles, onDetails, onDesktop }: ActionsProps) {
  const { t } = useTranslation();
  const desktopLabel = t('remoteDesktop.title');
  const filesLabel = t('session.presentation.overview.actions.files.a11y');
  const moreLabel = t('session.menu.details');
  const pressDesktop = useNavigationCallback(onDesktop);
  const pressFiles = useNavigationCallback(onFiles);
  const pressDetails = useNavigationCallback(onDetails);
  const pressScreen = useNavigationCallback(screen?.onPress);
  const hasScreen = !!screen;
  const screenLabel = screen?.label;
  // Stack.Toolbar derives options from children identity. Keep the whole array
  // stable through navigation feedback and unrelated message/store updates.
  const items = useMemo(() => [
    detailsOnly ? null : <Stack.Toolbar.Button key="desktop"
      icon={require('../../assets/navigation/monitor.png')} iconRenderingMode="template"
      accessibilityLabel={desktopLabel} disabled={!available} onPress={pressDesktop} />,
    detailsOnly ? null : hasScreen ? <Stack.Toolbar.Button key="screen" icon="iphone"
      accessibilityLabel={screenLabel} disabled={!available} onPress={pressScreen} />
      : <Stack.Toolbar.Button key="files" icon={require('../../assets/navigation/folder.png')} iconRenderingMode="template"
        accessibilityLabel={filesLabel} disabled={!available || filesDisabled} onPress={pressFiles} />,
    <Stack.Toolbar.Button key="details" icon="ellipsis" accessibilityLabel={moreLabel}
      disabled={!available} onPress={pressDetails} />,
  ], [available, detailsOnly, filesDisabled, desktopLabel, filesLabel, moreLabel, hasScreen, screenLabel,
    pressDesktop, pressFiles, pressDetails, pressScreen]);
  return <Stack.Toolbar placement="right">{items}</Stack.Toolbar>;
}

type HeaderProps = ActionsProps & SessionHeaderNativeTitleProps & {
  titleMaxWidth: number;
  onBack(): void;
  onOpenSessionList?: () => void;
};

/** Horizontal system header keeps the existing custom title and native actions. */
export function SessionStackHeader({ titleMaxWidth, onBack, onOpenSessionList,
  available, detailsOnly, screen, filesDisabled, filesDisabledReason, onFiles, onDetails, onDesktop,
  title, tags, pinned, syncing, syncingImmediately, notice, onTagsPress, onTitleDoubleTap }: HeaderProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const backLabel = t('shared.back');
  const listLabel = t('home.drawer.openA11y');
  const desktopLabel = t('remoteDesktop.title');
  const filesLabel = t('session.presentation.overview.actions.files.a11y');
  const moreLabel = t('session.menu.details');
  const pressBack = useNavigationCallback(onBack);
  const pressList = useNavigationCallback(onOpenSessionList);
  const pressDesktop = useNavigationCallback(onDesktop);
  const pressFiles = useNavigationCallback(onFiles);
  const pressDetails = useNavigationCallback(onDetails);
  const pressScreen = useNavigationCallback(screen?.onPress);
  const pressTags = useNavigationCallback(onTagsPress);
  const rename = useNavigationCallback(onTitleDoubleTap);
  const hasList = !!onOpenSessionList;
  const hasScreen = !!screen;
  const screenLabel = screen?.label;
  const canPressTags = !!onTagsPress;
  const canRename = !!onTitleDoubleTap;
  // Tags are JSON presentation data; equal snapshots may arrive as new arrays.
  // Compare all fields, including removals, rather than freezing visible data.
  const stableTags = useStableValue(tags, (previous, next) => reuseJsonSnapshot(previous, next) === previous);
  const screenOptions = useMemo(() => ({ headerShown: true, headerTransparent: true,
      headerShadowVisible: false, headerBackVisible: false, headerTitleAlign: 'center' as const,
      headerStyle: { backgroundColor: 'transparent' }, headerTintColor: colors.textPrimary,
      // Route-owned title options survive its unmount during a pop transition.
      headerTitle: () => <View style={{ width: titleMaxWidth, height: navigationChrome.target,
        minWidth: 0, flexShrink: 1, overflow: 'hidden', justifyContent: 'center' }}>
        <SessionHeaderNativeTitle title={title} pinned={pinned} tags={stableTags} onTagsPress={canPressTags ? pressTags : undefined}
          onTitleDoubleTap={canRename ? rename : undefined} syncing={syncing} syncingImmediately={syncingImmediately} notice={notice} />
      </View>,
    }), [colors.textPrimary, titleMaxWidth, title, pinned, stableTags, canPressTags, canRename,
      pressTags, rename, syncing, syncingImmediately, notice]);
  const leftItems = useMemo(() => [
      <Stack.Toolbar.View key="back" hidesSharedBackground>
        <SessionHeaderNativeBack label={backLabel} onPress={pressBack} />
      </Stack.Toolbar.View>,
      hasList ? <Stack.Toolbar.View key="list" hidesSharedBackground>
        <HomeHeaderGlassButton accessibilityLabel={listLabel}
          onPress={pressList} testID="session.sessionListButton">
          <Menu color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
        </HomeHeaderGlassButton>
      </Stack.Toolbar.View> : null,
    ], [backLabel, pressBack, hasList, listLabel, pressList, colors.textPrimary]);
  const rightItems = useMemo(() => (
      <Stack.Toolbar.View hidesSharedBackground>
        <SessionHeaderNativeActions available={available} detailsOnly={detailsOnly}
          desktopLabel={desktopLabel} filesLabel={filesLabel} moreLabel={moreLabel}
          files={{ disabled: filesDisabled, disabledReason: filesDisabledReason ?? null }}
          onDetails={pressDetails} onDesktop={pressDesktop}
          screen={hasScreen ? { label: screenLabel!, onPress: pressScreen } : undefined} onAction={pressFiles} />
      </Stack.Toolbar.View>
    ), [available, detailsOnly, desktopLabel, filesLabel, moreLabel, filesDisabled, filesDisabledReason,
      pressDetails, pressDesktop, hasScreen, screenLabel, pressScreen, pressFiles]);
  return <>
    <Stack.Screen options={screenOptions} />
    <Stack.Toolbar placement="left">{leftItems}</Stack.Toolbar>
    <Stack.Toolbar placement="right">{rightItems}</Stack.Toolbar>
  </>;
}
