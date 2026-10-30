import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { CodexResetAutoUseSettings, CodexResetAutoUseState } from '@cindy/maker-shared/device-link-contract';
import { Text, TextInput } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { typeScale, lineHeight, fontWeight, radius, spacing, iconSize } from '@/theme/tokens';

export function CodexResetAutoUseControl({ state, onSave }: {
  state: CodexResetAutoUseState;
  onSave: (patch: Partial<CodexResetAutoUseSettings> | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState(String(state.settings.minimumDays));
  const saving = useRef(false);
  useEffect(() => { setDays(String(state.settings.minimumDays)); setError(false); }, [state]);
  const s = state.settings;
  const label = (key: string, values?: Record<string, unknown>) => t(`session.resetAutoUse.${key}`, values);
  const save = async (patch: Partial<CodexResetAutoUseSettings> | null) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(false);
    try { await onSave(patch); } catch { setError(true); }
    finally { saving.current = false; setBusy(false); }
  };
  const condition = (field: 'lowQuota' | 'expiring') => void save({ [field]: !s[field],
    ...(s[field] && !s[field === 'lowQuota' ? 'expiring' : 'lowQuota'] ? { enabled: false } : {}) });
  const option = (text: string, selected: boolean, action: () => void, disabled = false) => (
    <Pressable key={text} accessibilityRole="button" accessibilityState={{ selected, disabled: busy || disabled }} disabled={busy || disabled}
      onPress={action} style={[styles.option, selected && styles.selected]}>
      <Text style={styles.optionText}>{text}</Text>
    </Pressable>
  );
  return <View>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={label('rules')} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.trigger}>
        <Text style={styles.title}>{label('label')}</Text>
        {expanded ? <ChevronUp size={iconSize.sm} color={colors.textSecondary} /> : <ChevronDown size={iconSize.sm} color={colors.textSecondary} />}
      </Pressable>
      <Switch accessibilityLabel={label('label')} value={s.enabled} disabled={busy || !state.accountKey}
        trackColor={{ false: colors.surfaceChip, true: colors.cta }} thumbColor={s.enabled ? colors.ctaText : colors.textSecondary}
        onValueChange={enabled => void save({ enabled, ...(enabled && !s.lowQuota && !s.expiring ? { lowQuota: true } : {}) })} />
    </View>
    {expanded && <View style={styles.rules}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: s.lowQuota, disabled: busy }} disabled={busy} onPress={() => condition('lowQuota')} style={styles.condition}>
        <Text style={styles.title}>{s.lowQuota ? '☑' : '☐'}  {label('lowQuota')}</Text>
      </Pressable>
      {s.lowQuota && <View>
        <Text style={styles.hint}>{label('resetDistance')}</Text>
        <View style={styles.options}>{[3, 2, 1, 0].map(n => option(n ? label('days', { count: n }) : label('unlimited'), !custom && n === s.minimumDays, () => { setCustom(false); void save({ minimumDays: n }); }))}
          {option(label('custom'), custom || ![0, 1, 2, 3].includes(s.minimumDays), () => setCustom(true))}</View>
        {(custom || ![0, 1, 2, 3].includes(s.minimumDays)) && <View style={styles.options}>
          <TextInput accessibilityLabel={label('customDays')} value={days} onChangeText={setDays} keyboardType="number-pad" editable={!busy} style={styles.input} />
          {option(label('apply'), false, () => { if (/^\d+$/.test(days) && Number(days) <= 365) void save({ minimumDays: Number(days) }); }, !/^\d+$/.test(days) || Number(days) > 365)}
        </View>}
      </View>}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: s.expiring, disabled: busy }} disabled={busy} onPress={() => condition('expiring')} style={styles.condition}>
        <Text style={styles.title}>{s.expiring ? '☑' : '☐'}  {label('expiring')}</Text>
      </Pressable>
      {s.expiring && <View style={styles.options}>{[30, 60, 360, 1440].map(n => option(label(n === 30 ? 'minutes' : 'hours', { count: n === 30 ? 30 : n / 60 }), s.expiryMinutes === n, () => void save({ expiryMinutes: n })))}</View>}
      <Text style={styles.hint}>{label('hint')}</Text>
      {state.customized && option(label('restore'), false, () => { setCustom(false); void save(null); })}
    </View>}
    {error && <Text accessibilityRole="alert" style={styles.hint}>{label('failed')}</Text>}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  trigger: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, flexShrink: 1 },
  title: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  rules: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.container, padding: spacing.md, gap: spacing.sm },
  condition: { minHeight: 48, justifyContent: 'center' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.xs },
  option: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
  optionText: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  hint: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  input: { minHeight: 48, minWidth: 72, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, fontSize: typeScale.body, fontWeight: fontWeight.regular, color: colors.textPrimary },
});
