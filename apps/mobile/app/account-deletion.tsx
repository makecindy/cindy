import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import {
  AuthApiError,
  type AccountDeletionAvailability,
  type AccountDeletionChallenge,
} from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import { loginText } from '@/auth/loginMessages';
import { Text, TextInput } from '@/components/AppText';
import {
  MainWindowActionButton,
  ScreenHeader,
} from '@/components/MobilePrimitives';
import { goBackGuarded } from '@/utils/backGuard';
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

export default function AccountDeletionScreen() {
  // Subscribe to language changes: this screen renders via the non-reactive
  // loginText(), so useTranslation() is what re-renders it on locale switch.
  useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [availability, setAvailability] =
    useState<AccountDeletionAvailability | null>(null);
  const [challenge, setChallenge] =
    useState<AccountDeletionChallenge | null>(null);
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void auth
      .getAccountDeletionAvailability()
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(accountDeletionErrorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.getAccountDeletionAvailability]);

  const requestChallenge = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await auth.requestAccountDeletionChallenge();
      setChallenge(next);
      setCode('');
      setAcknowledged(false);
    } catch (cause) {
      setError(accountDeletionErrorText(cause));
    } finally {
      setBusy(false);
    }
  }, [auth, busy]);

  const confirm = useCallback(async () => {
    if (!challenge || code.length !== 6 || !acknowledged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.confirmAccountDeletion({
        challengeId: challenge.challengeId,
        receiptToken: challenge.receiptToken,
        code,
      });
    } catch (cause) {
      setError(accountDeletionErrorText(cause));
    } finally {
      setBusy(false);
    }
  }, [acknowledged, auth, busy, challenge, code]);

  const available = availability?.available;
  return (
    <SafeAreaView style={styles.safeArea} testID="accountDeletion.screen">
      <ScreenHeader
        backTestID="accountDeletion.backButton"
        onBack={() => goBackGuarded(router)}
        title={loginText('accountDeletionScreenTitle')}
        titleTestID="accountDeletion.title"
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          testID="accountDeletion.scroll"
        >
          {loading ? (
            <Text style={styles.helper} testID="accountDeletion.loading">
              {loginText('accountDeletionLoading')}
            </Text>
          ) : !available ? (
            <View style={styles.card} testID="accountDeletion.unavailable">
              <Text style={styles.cardTitle}>
                {loginText('accountDeletionUnavailableTitle')}
              </Text>
              <Text style={styles.helper}>
                {loginText('accountDeletionUnavailableCopy')}
              </Text>
            </View>
          ) : challenge ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {loginText('accountDeletionVerifyTitle')}
                </Text>
                <Text style={styles.body}>
                  {loginText('accountDeletionCodeSent').replace(
                    '{target}',
                    challenge.maskedTarget,
                  )}
                </Text>
                <TextInput
                  autoComplete="one-time-code"
                  editable={!busy}
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={(value) =>
                    setCode(value.replace(/\D/g, ''))
                  }
                  onSubmitEditing={() => void confirm()}
                  placeholder={loginText('codePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  returnKeyType="done"
                  style={styles.codeInput}
                  testID="accountDeletion.codeInput"
                  value={code}
                />
              </View>

              <Pressable
                accessibilityLabel={loginText('accountDeletionAcknowledgeA11y')}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: acknowledged }}
                disabled={busy}
                onPress={() => setAcknowledged((value) => !value)}
                style={({ pressed }) => [
                  styles.acknowledgement,
                  pressed && styles.pressed,
                ]}
                testID="accountDeletion.acknowledgement"
              >
                <View
                  style={[
                    styles.checkbox,
                    acknowledged && styles.checkboxChecked,
                  ]}
                >
                  {acknowledged ? (
                    <Check
                      color={colors.ctaText}
                      size={iconSize.sm}
                      strokeWidth={iconStroke.bold}
                    />
                  ) : null}
                </View>
                <Text style={styles.acknowledgementText}>
                  {loginText('accountDeletionAcknowledgeCopy')}
                </Text>
              </Pressable>

              {error ? (
                <Text style={styles.error} testID="accountDeletion.error">
                  {error}
                </Text>
              ) : null}
              <MainWindowActionButton
                action={{
                  accessibilityLabel: busy
                    ? loginText('accountDeletionConfirmingA11y')
                    : loginText('accountDeletionConfirmA11y'),
                  busy,
                  disabled: busy || code.length !== 6 || !acknowledged,
                  label: busy
                    ? loginText('accountDeletionConfirming')
                    : loginText('accountDeletionConfirm'),
                  onPress: () => void confirm(),
                  testID: 'accountDeletion.confirmButton',
                  tone: 'danger',
                }}
              />
              <MainWindowActionButton
                action={{
                  disabled: busy,
                  label: loginText('resendCode'),
                  onPress: () => void requestChallenge(),
                  testID: 'accountDeletion.resendButton',
                }}
                density="compact"
              />
            </>
          ) : (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {loginText('accountDeletionBeforeTitle')}
                </Text>
                <ImpactRow
                  text={loginText('accountDeletionImpactCurrentClient')}
                />
                <ImpactRow text={loginText('accountDeletionImpactGrace')} />
                <ImpactRow text={loginText('accountDeletionImpactPermanent')} />
              </View>
              {availability.manualAppleRevocationRequired ? (
                <View style={styles.notice} testID="accountDeletion.appleNotice">
                  <Text style={styles.body}>
                    {loginText('accountDeletionAppleNotice')}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.helper}>
                {loginText('accountDeletionCodeWillSend').replace(
                  '{target}',
                  availability.verification?.maskedTarget ?? '',
                )}
              </Text>
              {error ? (
                <Text style={styles.error} testID="accountDeletion.error">
                  {error}
                </Text>
              ) : null}
              <MainWindowActionButton
                action={{
                  busy,
                  disabled: busy,
                  label: busy
                    ? loginText('accountDeletionSendingCode')
                    : loginText('sendCode'),
                  onPress: () => void requestChallenge(),
                  testID: 'accountDeletion.sendCodeButton',
                  tone: 'danger',
                }}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ImpactRow({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.impactRow}>
      <View style={styles.bullet} />
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

function accountDeletionErrorText(cause: unknown): string {
  if (cause instanceof AuthApiError) {
    switch (cause.code) {
      case 'ACCOUNT_DELETION_CHALLENGE_INVALID':
        return loginText('accountDeletionErrorChallenge');
      case 'CODE_ATTEMPTS_EXCEEDED':
        return loginText('accountDeletionErrorAttempts');
      case 'RATE_LIMITED':
        return loginText('accountDeletionErrorRate');
      case 'ACCOUNT_DELETION_PENDING':
        return loginText('accountDeletionErrorPending');
      case 'ACCOUNT_DELETION_PROCESSING':
        return loginText('accountDeletionErrorProcessing');
      case 'ACCOUNT_DELETION_UNAVAILABLE':
        return loginText('accountDeletionErrorUnavailable');
      case 'NETWORK_ERROR':
      case 'REQUEST_TIMEOUT':
        return loginText('accountDeletionErrorNetwork');
      default:
        break;
    }
  }
  return loginText('accountDeletionErrorFallback');
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safeArea: { backgroundColor: colors.surface, flex: 1 },
    flex: { flex: 1 },
    content: {
      gap: spacing.lg,
      paddingBottom: spacing.xxl,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xl,
    },
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      padding: spacing.lg,
    },
    cardTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
    },
    body: {
      color: colors.textSecondary,
      flex: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
    },
    helper: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
    },
    error: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
    },
    impactRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    bullet: {
      backgroundColor: colors.textTertiary,
      borderRadius: radius.pill,
      height: 5,
      marginTop: 9,
      width: 5,
    },
    notice: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.borderStrong,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      padding: spacing.lg,
    },
    codeInput: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.title,
      letterSpacing: 8,
      minHeight: 56,
      paddingHorizontal: spacing.lg,
      textAlign: 'center',
    },
    acknowledgement: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
    },
    acknowledgementText: {
      color: colors.textSecondary,
      flex: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    checkbox: {
      alignItems: 'center',
      borderColor: colors.borderStrong,
      borderRadius: radius.micro,
      borderWidth: 1,
      height: 22,
      justifyContent: 'center',
      marginTop: 1,
      width: 22,
    },
    checkboxChecked: {
      backgroundColor: colors.cta,
      borderColor: colors.cta,
    },
    pressed: { opacity: 0.6 },
  });
