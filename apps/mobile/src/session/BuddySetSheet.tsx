import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Check, Trash2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import {
  BUDDY_SET_LIMIT,
  createBuddySet,
  deleteBuddySet,
  reconcileBuddySetMembers,
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

  const atLimit = !buddySetId && buddySets.sets.length >= BUDDY_SET_LIMIT;
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || atLimit) return;
    // The id is generated once, before the state updater runs: a refused create
    // must not fall back to "the last set", which would edit an existing set.
    const newId = `buddy-set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const targetId = buddySetId ?? newId;
    const candidateIds = candidates.map((candidate) => candidate.id);
    onChange((state) => {
      const next = buddySetId
        ? renameBuddySet(state, buddySetId, trimmed)
        : createBuddySet(state, newId, trimmed);
      // Reconcile only this set: unchecking a buddy must not clear other sets.
      return reconcileBuddySetMembers(next, targetId, candidateIds, selected);
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
    trailingAction={{ label: copy.save, disabled: !name.trim() || atLimit, onPress: save, testID: 'buddySet.save' }}
    testID="buddySet.sheet">
    <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.field}>
        <Text style={styles.label}>{copy.nameLabel}</Text>
        <TextInput value={name} maxLength={80} placeholder={copy.namePlaceholder}
          placeholderTextColor={colors.textPlaceholder} onChangeText={setName}
          style={styles.input} testID="buddySet.name" />
        {atLimit ? <Text style={styles.limit}>{copy.limitReached}</Text> : null}
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
  limit: { color: colors.destructive, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.container, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, color: colors.textPrimary, backgroundColor: colors.surface, fontSize: typeScale.body },
  group: { borderRadius: radius.container, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, backgroundColor: colors.surface },
  lastRow: { borderBottomWidth: 0 },
  rowTitle: { flex: 1, color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  check: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.cta, borderColor: colors.cta },
  deleteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingVertical: spacing.sm },
  deleteText: { color: colors.destructive, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
});
