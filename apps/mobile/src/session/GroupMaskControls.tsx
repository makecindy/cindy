import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { ChatMaskIdentity, ChatMaskMention } from '@cindy/maker-shared/botGroupChat';
import { useTranslation } from 'react-i18next';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, radius, typeScale, lineHeight, fontWeight, iconSize } from '@/theme/tokens';
import { chatMemberAvatar } from '@/chat/chatServerClient';
import { botGroupMemberAvatar } from './botGroupRemote';
import { NativeSwitch, showConfirm } from '@/platform/chrome';
import { CompanionSheet } from './CompanionSheet';
import { BotGroupMenu } from './BotGroupMenu';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { GroupPersonalMask } from './useGroupPersonalMask';

// Overlapping avatar geometry belongs to this composition, like BotGroupDuoAvatar.
const avatarSizes = { self: 28, companion: 18, reply: 20 } as const;
const key = (name: string) => `groupChat.mask.${name}`;
const maskIdentity = (value: ChatMaskIdentity) => ({ botId: value.id, name: value.name, ...chatMemberAvatar(value.avatarUrl), avatar: botGroupMemberAvatar({ name: value.name, ...chatMemberAvatar(value.avatarUrl), avatarColor: '' }) });
export function GroupMaskAvatar({ self, companion, deviceId = '' }: { self: ChatMaskIdentity; companion: ChatMaskIdentity; deviceId?: string }) {
  const { colors } = useTheme(), { t } = useTranslation();
  return <View style={{ width: 36, height: 36 }} accessible accessibilityLabel={t(key('attribution'), { name: companion.name, owner: self.name })}>
    <BotGroupAvatar deviceId={deviceId} identity={maskIdentity(self)} size={avatarSizes.self} online />
    <View style={{ position: 'absolute', right: 0, bottom: 0, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.surface }}>
      <BotGroupAvatar deviceId={deviceId} identity={maskIdentity(companion)} size={avatarSizes.companion} online />
    </View>
  </View>;
}
export function GroupMaskStatus({ mask, onPress, deviceId }: { mask: GroupPersonalMask; onPress(): void; deviceId: string }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const state = mask.state, companion = state?.companions.find(c => c.id === state.settings.companionId);
  if (!state || !companion) return null;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${t(key('title'))} · ${t(key(`status.${state.status}`))}`}
    style={styles.status} testID="botGroup.mask.status">
    <GroupMaskAvatar self={state.self} companion={companion} deviceId={deviceId} />
    <Text style={styles.secondary} numberOfLines={1}>{t(key(`status.${state.status}`))}</Text>
  </Pressable>;
}
export function GroupMaskSettingsSheet({ visible, mask, onClose, onClosed }: { visible: boolean; mask: GroupPersonalMask; onClose(): void; onClosed?(): void }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const state = mask.state, settings = state?.settings;
  const live = useRef({ visible, owner: state?.self.id, companionId: settings?.companionId, update: mask.update });
  live.current = { visible, owner: state?.self.id, companionId: settings?.companionId, update: mask.update };
  useEffect(() => () => { live.current.visible = false; }, []);
  const [times, setTimes] = useState({ start: '', end: '' });
  useEffect(() => { if (settings) setTimes({ start: settings.start, end: settings.end }); }, [settings?.start, settings?.end, visible]);
  const pick = (label: string, value: string, options: Array<{ id: string; title: string }>, select: (value: string) => void) =>
    <BotGroupMenu title={label} accessibilityLabel={label} disabled={mask.saving} sections={[{ id: 'options', options: options.map(o => ({ ...o, selected: o.id === value })) }]} onSelect={select}>
      {open => <Pressable onPress={open} style={styles.row} accessibilityRole="button"><Text style={styles.label}>{label}</Text>
        <Text style={styles.value} numberOfLines={2}>{options.find(o => o.id === value)?.title ?? t(key('choose'))}</Text><ChevronDown size={iconSize.md} color={colors.textSecondary} /></Pressable>}
    </BotGroupMenu>;
  const toggle = (label: string, value: boolean, change: (value: boolean) => void, disabled = false) => <View style={styles.row}>
    <Text style={styles.label}>{label}</Text><NativeSwitch accessibilityLabel={label} value={value} disabled={mask.saving || disabled} onValueChange={change} /></View>;
  return <CompanionSheet visible={visible} title={t(key('title'))} onClose={onClose} onClosed={onClosed} testID="botGroup.mask.settings">
    <View style={styles.content}>
      {settings && state ? <>
        {pick(t(key('companion')), settings.companionId ?? '', state.companions.map(c => ({ id: c.id, title: c.name })), companionId => mask.update({ companionId }))}
        {toggle(t(key('enabled')), settings.enabled, enabled => mask.update({ enabled }), !settings.companionId)}
        {state.toolAccessSupported ? pick(t(key('toolAccess')), settings.access ?? 'chat', ['chat', 'tools'].map(id => ({ id, title: t(key(`access.${id}`)) })), async access => {
          const owner = state.self.id;
          if (access === 'tools' && !await showConfirm({ title: t(key('access.authorizeTitle'), { name: state.companions.find(c => c.id === settings.companionId)?.name ?? '' }), message: t(key('access.toolsHint')), cancelLabel: t('devices.common.cancel'), confirmLabel: t(key('access.confirm')) })) return;
          if (live.current.visible && live.current.owner === owner && live.current.companionId === settings.companionId) live.current.update({ access: access as 'chat' | 'tools' });
        }) : null}
        {pick(t(key('triggerLabel')), settings.trigger, ['always', 'manual', 'scheduled'].map(id => ({ id, title: t(key(`trigger.${id}`)) })), trigger => mask.update({ trigger: trigger as typeof settings.trigger }))}
        {settings.trigger === 'scheduled' ? <View style={styles.row}>
          {(['start', 'end'] as const).map(field => <View key={field} style={styles.time}>
            <Text style={styles.secondary}>{t(key(field))}</Text><TextInput style={styles.input} value={times[field]} maxLength={5}
              accessibilityLabel={t(key(field))} placeholder="09:00" keyboardType="numbers-and-punctuation" editable={!mask.saving}
              onChangeText={value => setTimes(old => ({ ...old, [field]: value }))}
              onBlur={() => { if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(times[field])) mask.update({ [field]: times[field] });
                else setTimes(old => ({ ...old, [field]: settings[field] })); }} />
          </View>)}
        </View> : null}
        {pick(t(key('resumeAfter')), String(settings.resumeMinutes), [...new Set([5, 15, 30, 60, settings.resumeMinutes])].sort((a,b) => a-b).map(n => ({ id: String(n), title: t(key('minutes'), { count: n }) })), value => mask.update({ resumeMinutes: Number(value) }))}
        {settings.enabled && settings.companionId ? <MainWindowActionButton action={{
          label: t(key(state.status === 'enabled' ? 'takeover' : settings.trigger === 'manual' ? 'startManual' : 'resume')),
          disabled: mask.saving, onPress: () => mask.perform(state.status === 'enabled' ? 'participate' : 'resume'),
        }} /> : null}
        {settings.trigger === 'manual' && state.manualRunning ? <MainWindowActionButton action={{ label: t(key('stop')), disabled: mask.saving, onPress: () => mask.perform('stop') }} /> : null}
        {toggle(t(key('todos')), settings.collectTodos, collectTodos => mask.update({ collectTodos }), !settings.companionId)}
        {settings.collectTodos ? <>
          {pick(t(key('digestLabel')), settings.digest, ['daily','manual'].map(id => ({ id, title: t(key(`digest.${id}`)) })), digest => mask.update({ digest: digest as 'daily' | 'manual' }))}
          <MainWindowActionButton action={{ label: t(key(state.digestStatus === 'done' ? 'digestSent' : state.digestStatus === 'empty' ? 'digestEmpty' : state.digestStatus === 'failed' ? 'digestFailed' : 'digestNow')),
            busy: ['queued','running'].includes(state.digestStatus ?? ''), disabled: mask.saving || !settings.companionId, onPress: () => mask.perform('digest') }} />
        </> : null}
      </> : <Text style={styles.secondary}>{t(key('loading'))}</Text>}
      {mask.error ? <MainWindowActionButton action={{ label: t(key('retry')), onPress: mask.retry }} /> : null}
    </View>
  </CompanionSheet>;
}
export function GroupMaskCatchupSheet({ visible, mask, onClose, onClosed, onLocate }: { visible: boolean; mask: GroupPersonalMask; onClose(): void; onClosed?(): void; onLocate(mention: ChatMaskMention): void }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);
  return <CompanionSheet visible={visible} title={t(key('catchup.title'))} onClose={onClose} onClosed={onClosed}
    footer={mask.mentions.length ? <MainWindowActionButton action={{ label: t(key('catchup.markAll')), disabled: mask.saving, onPress: () => mask.markRead(mask.mentions.map(m => m.messageId)) }} /> : undefined}>
    <View style={styles.content}>
      {!mask.mentions.length ? <Text style={styles.secondary}>{t(key('catchup.empty'))}</Text> : null}
      {mask.mentions.map(mention => <View key={mention.messageId} style={styles.mention}>
        <View style={styles.row}>
          <Text style={[styles.label, styles.author]}>{mention.authorName}</Text>
          {mention.reply ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === mention.messageId }} style={styles.disclosure}
            onPress={() => setExpanded(value => value === mention.messageId ? null : mention.messageId)}>
            <Text style={styles.secondary}>{t(key('catchup.answered'))}</Text><ChevronDown size={iconSize.md} color={colors.textSecondary} />
          </Pressable> : null}
        </View>
        <Pressable accessibilityRole="button" onPress={() => onLocate(mention)} style={styles.question}>
          <Text style={styles.body}>{mention.text}</Text><ChevronRight size={iconSize.lg} color={colors.textSecondary} />
        </Pressable>
        {expanded === mention.messageId && mention.reply ? <View style={styles.reply}>
          <BotGroupAvatar deviceId="" identity={maskIdentity(mention.reply.companion)} size={avatarSizes.reply} online />
          <Text style={[styles.body, { color: colors.textSecondary }]}>{mention.reply.text}</Text>
        </View> : null}
      </View>)}
      {mask.error ? <MainWindowActionButton action={{ label: t(key('retry')), onPress: mask.retry }} /> : null}
    </View>
  </CompanionSheet>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: spacing.sm },
  label: { flex: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary },
  body: { flex: 1, fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed, color: colors.textPrimary },
  value: { flexShrink: 1, maxWidth: '55%', fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textSecondary, textAlign: 'right' },
  secondary: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, color: colors.textSecondary },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 44 },
  time: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: { flex: 1, minHeight: 44, fontSize: typeScale.body, color: colors.textPrimary },
  mention: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingBottom: spacing.md },
  author: { fontWeight: fontWeight.semibold },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 44 },
  question: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  reply: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingTop: spacing.md },
});
