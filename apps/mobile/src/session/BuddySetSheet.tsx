import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Check, Trash2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import {
  assignBuddyToSet,
  createBuddySet,
  deleteBuddySet,
  normalizeBuddySets,
  removeBuddyFromSet,
  renameBuddySet,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { Text, TextInput } from '@/components/AppText';
import { FormSheet } from './FormSheet';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { mobileBuddySetCopy, type BuddySetCandidate } from './buddySetCopy';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';

/** Create or edit one buddy set: name, membership, delete. Purely local display state. */
export function BuddySetSheet({ visible, buddySetId, buddySets, candidates, onChange, onClose }: {
  visible: boolean;
  /** null = create a new set. */
  buddySetId: string | null;
  buddySets: BuddySetsState;
  candidates: readonly BuddySetCandidate[];
  onChange: (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const copy = mobileBuddySetCopy(t);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const current = buddySets.sets.find((set) => set.buddySetId === buddySetId) ?? null;
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setName(current?.name ?? '');
    setSelected(current?.buddyIds ?? []);
  }, [visible, current?.buddySetId, current?.name]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onChange((state) => {
      let next = buddySetId
        ? renameBuddySet(state, buddySetId, trimmed)
        : createBuddySet(state, `buddy-set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, trimmed);
      const targetId = buddySetId ?? next.sets[next.sets.length - 1]?.buddySetId;
      if (!targetId) return next;
      // Reconcile membership: assignBuddyToSet enforces "one buddy, one set".
      for (const candidate of candidates) {
        next = selected.includes(candidate.id)
          ? assignBuddyToSet(next, candidate.id, targetId)
          : removeBuddyFromSet(next, candidate.id);
      }
      return normalizeBuddySets(next);
    });
    onClose();
  };

  const toggle = (id: string) => setSelected((prev) =>
    prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]);

  const remove = () => {
    if (buddySetId) onChange((state) => deleteBuddySet(state, buddySetId));
    onClose();
  };

  return <FormSheet visible={visible} title={current ? copy.renameTitle : copy.createTitle} onClose={onClose}
    leadingAction={{ label: copy.close, onPress: onClose, testID: 'buddySet.cancel' }}
    trailingAction={{ label: copy.save, disabled: !name.trim(), onPress: save, testID: 'buddySet.save' }}
    testID="buddySet.sheet">
    <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.field}>
        <Text style={styles.label}>{copy.nameLabel}</Text>
        <TextInput value={name} maxLength={80} placeholder={copy.namePlaceholder}
          placeholderTextColor={colors.textPlaceholder} onChangeText={setName}
          style={styles.input} testID="buddySet.name" />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>{copy.membersLabel}</Text>
        <View style={styles.group}>
          {candidates.map((candidate, index) => {
            const checked = selected.includes(candidate.id);
            return <Pressable key={candidate.id} accessibilityRole="checkbox" accessibilityLabel={candidate.name}
              accessibilityState={{ checked }} onPress={() => toggle(candidate.id)}
              style={({ pressed }) => [styles.row, index === candidates.length - 1 && styles.lastRow, pressed && mobileInteractionStyles.pressed]}
              testID={`buddySet.member.${candidate.id}`}>
              <Text numberOfLines={1} style={styles.rowTitle}>{candidate.name}</Text>
              <View style={[styles.check, checked && styles.checked]}>
                {checked ? <Check size={iconSize.xs} color={colors.ctaText} strokeWidth={iconStroke.bold} /> : null}
              </View>
            </Pressable>;
          })}
        </View>
      </View>
      {current ? <Pressable accessibilityRole="button" onPress={remove}
        style={({ pressed }) => [styles.deleteRow, pressed && mobileInteractionStyles.pressed]} testID="buddySet.delete">
        <Trash2 size={iconSize.sm} color={colors.destructive} strokeWidth={iconStroke.regular} />
        <Text style={styles.deleteText}>{copy.delete}</Text>
      </Pressable> : null}
    </ScrollView>
  </FormSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  field: { marginBottom: spacing.lg, gap: spacing.sm },
  label: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.container, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, color: colors.textPrimary, backgroundColor: colors.surface, fontSize: typeScale.body },
  group: { borderRadius: radius.container, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, backgroundColor: colors.surface },
  lastRow: { borderBottomWidth: 0 },
  rowTitle: { flex: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  check: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.cta, borderColor: colors.cta },
  deleteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingVertical: spacing.sm },
  deleteText: { color: colors.destructive, fontSize: typeScale.body, lineHeight: lineHeight.body },
});
