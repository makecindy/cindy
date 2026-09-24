import { iconSize } from '@/theme';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Copy, Check, Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { NativePullDownMenu, usesNativePullDownMenu, type NativePullDownAction } from '@/platform/chrome/NativePullDownMenu';
import { useTheme, spacing } from '@/theme';
import { CompanionSheet } from './CompanionSheet';

/** Compact companion controls; the existing task handlers still own every operation. */
export function CompanionMessageActions({ user, copied, copying, disabled, onCopy, actions, onAction }: {
  user: boolean; copied: boolean; copying: boolean; disabled: boolean;
  onCopy?: () => void; actions: NativePullDownAction[]; onAction(id: string): void;
}) {
  const { t } = useTranslation(); const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const pending = useRef<string | null>(null);
  const hit = { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const };
  return <View style={{ flexDirection: 'row', justifyContent: user ? 'flex-end' : 'flex-start' }} testID="companion.messageActions">
    {!user && onCopy ? <Pressable style={hit} disabled={disabled || copying} accessibilityRole="button" accessibilityLabel={t(copied ? 'message.renderer.copyStateCopied' : 'message.renderer.copyStateCopy')} onPress={onCopy} testID="message.copyButton">
      {copied ? <Check size={iconSize.sm} color={colors.textSecondary} /> : <Copy size={iconSize.sm} color={colors.textSecondary} />}
    </Pressable> : null}
    <NativePullDownMenu actions={actions} onAction={onAction}>
      <Pressable style={hit} disabled={disabled} accessibilityRole="button" accessibilityLabel={t('message.renderer.moreActions')} testID="companion.messageMore" onPress={() => { if (!usesNativePullDownMenu()) setOpen(true); }}>
        <Ellipsis size={iconSize.sm} color={colors.textSecondary} />
      </Pressable>
    </NativePullDownMenu>
    <CompanionSheet visible={open} title="" onClose={() => { pending.current = null; setOpen(false); }} onClosed={() => { const id = pending.current; pending.current = null; if (id) onAction(id); }}>
      {actions.map(action => <Pressable key={action.id} disabled={action.disabled} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md }} onPress={() => { pending.current = action.id; setOpen(false); }}>
        <Text style={{ color: action.destructive ? colors.destructive : action.disabled ? colors.textSecondary : colors.textPrimary }}>{action.title}</Text>
      </Pressable>)}
    </CompanionSheet>
  </View>;
}
