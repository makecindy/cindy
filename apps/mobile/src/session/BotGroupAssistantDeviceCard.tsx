/**
 * The requester's own group-Cindy requests held until they choose a computer (bot-group-chat.md
 * 第 9 节), docked above the composer like Desktop's card. Only this member sees it; the rest of
 * the group sees no notice or running state for it. Continue sets the computer, which releases
 * every held request; cancel ends them.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { EyeOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupRemoteActionId, BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, radius, spacing, textStyles } from '@/theme/tokens';
import { BotGroupMenu } from './BotGroupMenu';
import { botGroupActionErrorText } from './botGroupCopy';

type Group = Pick<BotGroupRemoteChatData, 'assistantComputers' | 'assistantDeviceWaits'>;

export function BotGroupAssistantDeviceCard({ group, online, act }: {
  group: Group;
  online: boolean;
  act(action: BotGroupRemoteActionId, input: Record<string, unknown>): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const computers = group.assistantComputers ?? [];
  const waits = group.assistantDeviceWaits ?? [];
  const [deviceId, setDeviceId] = useState('');
  const [pending, setPending] = useState<'continue' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const chosen = computers.find(computer => computer.id === deviceId) ?? computers[0];
  if (!waits.length || !chosen) return null;

  const run = async (kind: 'continue' | 'cancel', calls: Array<[BotGroupRemoteActionId, Record<string, unknown>]>) => {
    if (pending) return;
    setPending(kind); setError('');
    try { for (const [action, input] of calls) await act(action, input); }
    catch (failure) { if (mounted.current) setError(botGroupActionErrorText(t, failure, 'groupChat.groupSettings.saveFailed')); }
    finally { if (mounted.current) setPending(null); }
  };
  const [first] = waits;
  const request = waits.length > 1 ? t('groupChat.assistantDevice.requests', { count: waits.length })
    : first.requestText ? t('groupChat.assistantDevice.request', { request: first.requestText }) : t('groupChat.assistantDevice.requestUnknown');
  const disabled = !online || !!pending;
  const label = t('groupChat.groupSettings.assistantComputer');
  return (
    <View style={styles.card} testID="botGroup.assistantDevice">
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">{t('groupChat.assistantDevice.title')}</Text>
        <View style={styles.private}>
          <EyeOff size={iconSize.xs} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
          <Text style={styles.privateText}>{t('groupChat.assistantDevice.onlyYou')}</Text>
        </View>
      </View>
      {/* Two sentences, two lines: languages join sentences differently (no space in Chinese or Japanese). */}
      <View>
        <Text style={styles.body}>{request}</Text>
        <Text style={styles.body}>{t('groupChat.assistantDevice.remember')}</Text>
      </View>
      <BotGroupMenu testID="botGroup.assistantDevice.computer" title={label} accessibilityLabel={label} disabled={disabled}
        sections={[{ id: 'computer', options: computers.map(computer => ({ id: computer.id, title: computer.name, selected: computer.id === chosen.id })) }]}
        onSelect={setDeviceId}>
        {open => <MainWindowActionButton density="compact" style={styles.picker}
          action={{ label: chosen.name, accessibilityLabel: `${label}: ${chosen.name}`, disabled, onPress: open, testID: 'botGroup.assistantDevice.computerButton' }}
          textStyle={styles.pickerText} />}
      </BotGroupMenu>
      <View style={styles.actions}>
        <MainWindowActionButton density="compact" grow action={{ label: t('groupChat.assistantDevice.cancel'), disabled, busy: pending === 'cancel',
          testID: 'botGroup.assistantDevice.cancel',
          onPress: () => void run('cancel', waits.map(wait => ['cancelAssistantDeviceWait', { executionId: wait.executionId }])) }} />
        <MainWindowActionButton density="compact" grow action={{ label: t('groupChat.assistantDevice.continue'), tone: 'primary', disabled, busy: pending === 'continue',
          testID: 'botGroup.assistantDevice.continue',
          onPress: () => void run('continue', [['assistantDevice', { deviceId: chosen.id }]]) }} />
      </View>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.container, marginHorizontal: spacing.md, marginBottom: spacing.xs, padding: spacing.md, gap: spacing.sm },
    header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: spacing.sm, rowGap: spacing.xs },
    title: { ...textStyles.body, fontWeight: fontWeight.medium, color: colors.textPrimary, flexShrink: 1 },
    private: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    privateText: { ...textStyles.caption, color: colors.textTertiary },
    body: { ...textStyles.footnote, color: colors.textSecondary },
    picker: { alignSelf: 'stretch' },
    pickerText: { flexShrink: 1 },
    actions: { flexDirection: 'row', gap: spacing.sm },
    error: { ...textStyles.footnote, color: colors.errorText },
  });
}
