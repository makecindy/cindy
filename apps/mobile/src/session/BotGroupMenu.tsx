/**
 * 群聊里贴着控件弹出的小菜单（步骤换人、输入框「+」、选电脑）。iOS 用系统 UIMenu、
 * Android 用 Cindy 自绘的 AnchoredPullDownMenu（都经 NativePullDownMenu）；iOS 包里还没有
 * MenuView 时退回同样选项的底部面板，等面板收起后再执行选中的项，避免两层遮罩叠在一起。
 */
import { useRef, useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { MainWindowRowButton } from '@/components/MobilePrimitives';
import { NativePullDownMenu, usesNativePullDownMenu, type NativePullDownAction } from '@/platform/chrome/NativePullDownMenu';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { CompanionSheet } from './CompanionSheet';

export interface BotGroupMenuOption {
  id: string;
  title: string;
  subtitle?: string;
  disabled?: boolean;
  destructive?: boolean;
  selected?: boolean;
}

export interface BotGroupMenuSection {
  id: string;
  title?: string;
  options: readonly BotGroupMenuOption[];
}

function toAction(option: BotGroupMenuOption): NativePullDownAction {
  return {
    id: option.id,
    title: option.title,
    ...(option.subtitle ? { subtitle: option.subtitle } : {}),
    ...(option.disabled ? { disabled: true } : {}),
    ...(option.destructive ? { destructive: true } : {}),
    ...(option.selected ? { state: 'on' as const } : {}),
  };
}

export function botGroupMenuActions(sections: readonly BotGroupMenuSection[]): NativePullDownAction[] {
  return sections.flatMap((section): NativePullDownAction[] => section.title
    ? [{ id: `section:${section.id}`, title: section.title, displayInline: true, subactions: section.options.map(toAction) }]
    : section.options.map(toAction));
}

export function BotGroupMenu({ title, sections, onSelect, accessibilityLabel, disabled = false, testID, children }: {
  /** Fallback sheet title. */
  title: string;
  sections: readonly BotGroupMenuSection[];
  onSelect(id: string): void;
  accessibilityLabel?: string;
  disabled?: boolean;
  testID?: string;
  /** The trigger. `open` is set only when the fallback sheet has to be opened by the trigger itself. */
  children(open: (() => void) | undefined): ReactElement;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [sheet, setSheet] = useState(false);
  const chosen = useRef<string | null>(null);
  const known = new Set(sections.flatMap((section) => section.options.filter((option) => !option.disabled).map((option) => option.id)));
  const select = (id: string) => { if (known.has(id)) onSelect(id); };
  if (usesNativePullDownMenu()) {
    return <NativePullDownMenu actions={botGroupMenuActions(sections)} onAction={select} disabled={disabled}
      accessibilityLabel={accessibilityLabel} testID={testID}>
      {children(undefined)}
    </NativePullDownMenu>;
  }
  return <>
    {children(disabled ? undefined : () => setSheet(true))}
    <CompanionSheet visible={sheet} title={title} onClose={() => { chosen.current = null; setSheet(false); }}
      onClosed={() => { const id = chosen.current; chosen.current = null; if (id) select(id); }} testID={testID ? `${testID}.sheet` : undefined}>
      <View style={styles.content}>
        {sections.map((section) => <View key={section.id} style={styles.section}>
          {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
          {section.options.map((option) => <MainWindowRowButton key={option.id} accessibilityLabel={option.title}
            accessibilityState={{ checked: option.selected }} disabled={option.disabled} selected={option.selected}
            onPress={() => { chosen.current = option.id; setSheet(false); }} style={styles.row} testID={testID ? `${testID}.option.${option.id}` : undefined}>
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.title, option.destructive && { color: colors.destructive }]}>{option.title}</Text>
              {option.subtitle ? <Text style={styles.subtitle}>{option.subtitle}</Text> : null}
            </View>
            {option.selected ? <Check size={iconSize.md} color={colors.textSecondary} /> : null}
          </MainWindowRowButton>)}
        </View>)}
      </View>
    </CompanionSheet>
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  section: { gap: spacing.xs },
  sectionTitle: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  row: { minHeight: 48, gap: spacing.md, paddingVertical: spacing.sm },
  rowText: { flex: 1, minWidth: 0, gap: spacing.xs },
  title: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  subtitle: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
