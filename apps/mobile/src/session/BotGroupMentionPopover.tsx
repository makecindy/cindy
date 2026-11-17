import type { ReactNode } from 'react';
import { Host, Box, DropdownMenu, RNHostView } from '@expo/ui/jetpack-compose';
import { size } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';
import type { BotGroupMentionPoint } from './botGroupMentions';

export interface BotGroupMentionPopoverProps {
  position: BotGroupMentionPoint;
  width: number;
  onClose(): void;
  avatar: ReactNode;
  name: string;
  displayName?: string;
  caption: string;
}

/** Material owns popup placement, focus and outside/back dismissal. */
export function BotGroupMentionPopover({ position, width, onClose, avatar, name, displayName, caption }: BotGroupMentionPopoverProps) {
  const { mode, colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <Host colorScheme={mode} seedColor={colors.textPrimary}
    style={{ position: 'absolute', left: position.x, top: position.y, width: 1, height: 1 }}>
    <DropdownMenu expanded onDismissRequest={onClose} color={colors.surfaceElevated}>
      <DropdownMenu.Trigger><Box modifiers={[size(1, 1)]} /></DropdownMenu.Trigger>
      <DropdownMenu.Items>
        <RNHostView matchContents><View style={[styles.content, { width }]} testID="botGroup.mention.identity">
          {avatar}<View style={styles.details}><Text style={styles.name}>{name}</Text>
          {displayName ? <Text style={styles.meta}>{displayName}</Text> : null}
          {caption ? <Text style={styles.meta}>{caption}</Text> : null}</View>
        </View></RNHostView>
      </DropdownMenu.Items>
    </DropdownMenu>
  </Host>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  details: { flex: 1, minWidth: 0, gap: spacing.xs },
  name: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  meta: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
