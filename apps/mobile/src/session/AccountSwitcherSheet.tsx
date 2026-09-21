import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Building2, Check, UserPlus, UserRound } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { hasNativeLoginButtons, LoginNativeButton } from '@/components/LoginNativeButton';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { ComposerSheet } from '@/session/ComposerSheet';
import type { SheetSurfaceProps } from '@/session/SheetSurface';
import { presentSavedAccount } from '@/session/accountSwitcherPresentation';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

export function AccountSwitcherSheet({
  hasRunningTasks,
  onAddAccount,
  onClose,
  onClosed,
  visible,
}: {
  hasRunningTasks: boolean;
  onAddAccount(): void;
  onClose(): void;
  onClosed?(): void;
  visible: boolean;
}) {
  const auth = useAuth();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        safeAreaTopInset: insets.top,
        screenHeight: height,
      }),
    [height, insets.top],
  );

  useEffect(() => {
    if (!visible) return;
    setSnap('half');
    void auth.syncSavedAccounts().catch(() => undefined);
  }, [auth.syncSavedAccounts, visible]);

  const confirmBoundary = (action: () => void) => {
    if (!hasRunningTasks) {
      action();
      return;
    }
    Alert.alert(
      t('devices.list.accounts.runningTitle'),
      t('devices.list.accounts.runningMessage'),
      [
        { text: t('devices.common.cancel'), style: 'cancel' },
        {
          text: t('devices.list.accounts.switchConfirm'),
          style: 'destructive',
          onPress: action,
        },
      ],
    );
  };

  const switchTo = (accountKey: string) => {
    confirmBoundary(() => {
      setSwitchingKey(accountKey);
      void auth
        .switchAccount(accountKey)
        .then(onClose)
        .catch((error) => {
          Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(error));
        })
        .finally(() => setSwitchingKey(null));
    });
  };

  const footer = hasNativeLoginButtons ? (
    <LoginNativeButton label={t('devices.list.accounts.add')} height={48} fontSize={typeScale.body}
      disabled={switchingKey !== null} onPress={() => confirmBoundary(onAddAccount)}
      testID="accountSwitcher.addAccount" showLabel artworkSize={iconSize.md}>
      <UserPlus color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
    </LoginNativeButton>
  ) : (
    <Pressable
      accessibilityRole="button"
      disabled={switchingKey !== null}
      onPress={() => confirmBoundary(onAddAccount)}
      style={({ pressed }) => [
        styles.addButton,
        pressed && styles.pressed,
      ]}
      testID="accountSwitcher.addAccount"
    >
      <UserPlus
        color={colors.textPrimary}
        size={iconSize.md}
        strokeWidth={iconStroke.regular}
      />
      <Text style={styles.addLabel}>{t('devices.list.accounts.add')}</Text>
    </Pressable>
  );

  return (
    <AccountSwitcherContainer
      onClose={onClose}
      onClosed={onClosed}
      visible={visible}
        bottomInset={insets.bottom}
        footer={footer}
        heights={heights}
        onSnapChange={setSnap}
        snap={snap}
        testID="accountSwitcher.sheet"
        title={t('devices.list.accounts.title')}
      >
        <View style={styles.list}>
          {auth.savedAccounts.map((account) => {
            const { imageUrl, isOrg, subtitle, title } =
              presentSavedAccount(account);
            const switching = switchingKey === account.accountKey;
            if (hasNativeLoginButtons) return <LoginNativeButton key={account.accountKey}
              label={title} subtitle={subtitle ?? undefined} height={64} fontSize={typeScale.body}
              accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
              onPress={() => switchTo(account.accountKey)} variant="text" showLabel artworkSize={44}
              disabled={account.isCurrent || switchingKey !== null} busy={switching}
              selected={account.isCurrent} testID={`accountSwitcher.account.${account.membershipId}`}>
              <View style={styles.avatar}>
                {imageUrl ? <Image source={{ uri: imageUrl }} style={styles.avatarImage} />
                  : isOrg ? <Building2 color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                    : <UserRound color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
              </View>
            </LoginNativeButton>;
            return (
              <Pressable
                accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
                accessibilityRole="button"
                disabled={account.isCurrent || switchingKey !== null}
                key={account.accountKey}
                onPress={() => switchTo(account.accountKey)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                testID={`accountSwitcher.account.${account.membershipId}`}
              >
                <View style={styles.avatar}>
                  {imageUrl ? (
                    <Image source={{ uri: imageUrl }} style={styles.avatarImage} />
                  ) : isOrg ? (
                    <Building2
                      color={colors.textSecondary}
                      size={iconSize.md}
                      strokeWidth={iconStroke.regular}
                    />
                  ) : (
                    <UserRound
                      color={colors.textSecondary}
                      size={iconSize.md}
                      strokeWidth={iconStroke.regular}
                    />
                  )}
                </View>
                <View style={styles.texts}>
                  <Text numberOfLines={1} style={styles.title}>{title}</Text>
                  {subtitle ? (
                    <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
                  ) : null}
                </View>
                {switching ? (
                  <ActivityIndicator color={colors.textSecondary} size="small" />
                ) : account.isCurrent ? (
                  <Check
                    color={colors.textPrimary}
                    size={iconSize.md}
                    strokeWidth={iconStroke.regular}
                  />
                ) : null}
              </Pressable>
            );
          })}
          {auth.accountsLoading && auth.savedAccounts.length === 0 ? (
            <ActivityIndicator
              color={colors.textSecondary}
              style={styles.loading}
            />
          ) : null}
          {auth.accountsError ? (
            <Text style={styles.error}>{t('devices.list.accounts.syncFailed')}</Text>
          ) : null}
        </View>
    </AccountSwitcherContainer>
  );
}

function AccountSwitcherContainer({ visible, onClosed, children, ...surface }: SheetSurfaceProps & {
  visible: boolean; onClosed?: () => void; children: ReactNode;
}) {
  if (Platform.OS === 'ios') return <ComposerSheet
    visible={visible} onClose={surface.onClose} onClosed={onClosed}
    title={surface.title} footer={surface.footer} testID={surface.testID}
  >{children}</ComposerSheet>;
  return <SheetModal visible={visible} onRequestClose={surface.onClose}
    onBackdropPress={surface.onClose} onClosed={onClosed} backdropTestID="accountSwitcher.backdrop">
    <SheetSurface {...surface}>{children}</SheetSurface>
  </SheetModal>;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    list: {
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
    },
    row: {
      alignItems: 'center',
      borderRadius: radius.container,
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 64,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    avatar: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 44,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 44,
    },
    avatarImage: { height: 44, width: 44 },
    texts: { flex: 1, gap: 2, minWidth: 0 },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    addButton: {
      alignItems: 'center',
      borderRadius: radius.container,
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'center',
      minHeight: 48,
      marginHorizontal: spacing.lg,
    },
    addLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    loading: { paddingVertical: spacing.xl },
    error: {
      color: colors.statusError,
      fontSize: typeScale.footnote,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      textAlign: 'center',
    },
    pressed: { opacity: 0.72 },
  });
