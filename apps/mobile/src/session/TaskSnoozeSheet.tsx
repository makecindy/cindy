import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { SessionActionSheetFrame } from './SessionActionSheetFrame';
import { TaskSnoozeDatePicker } from './TaskSnoozeDatePicker';
import { useTaskSnoozeSheet, type TaskSnoozeSheetProps } from './taskSnoozeSheetModel';

export function TaskSnoozeSheet(props: TaskSnoozeSheetProps) {
  const model = useTaskSnoozeSheet(props);
  const styles = useThemedStyles(makeStyles);
  const { t } = model;
  return <SessionActionSheetFrame visible={props.visible} onClose={props.onClose} onClosed={props.onClosed}>
    <View style={styles.card} testID="home.snoozeSheet">
      <Text style={styles.title}>{t('devices.list.menu.inbox.snooze')}</Text>
      {model.custom ? <>
        <TaskSnoozeDatePicker date={model.date} onChange={model.setDate} minimumDate={model.minimumDate} maximumDate={model.maximumDate} />
        <Pressable accessibilityRole="button" onPress={() => model.choose(model.date)} style={styles.row} testID="home.snoozeConfirm">
          <Text style={styles.label}>{t('devices.common.save')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => model.setCustom(false)} style={styles.row}>
          <Text style={styles.label}>{t('shared.back')}</Text>
        </Pressable>
      </> : <>
        {model.options.map(option => <Pressable key={option.id} accessibilityRole="button"
          onPress={() => model.choose(option.until)} style={({ pressed }) => [styles.row, pressed && styles.pressed]} testID={`home.snooze.${option.id}`}>
          <Text style={styles.label}>{option.label}</Text><Text style={styles.time}>{option.time}</Text>
        </Pressable>)}
        <Pressable accessibilityRole="button" onPress={model.chooseIndefinite} style={styles.row} testID="home.snooze.indefinite">
          <Text style={styles.label}>{t('devices.list.menu.inbox.indefinite')}</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable accessibilityRole="button" onPress={() => model.setCustom(true)} style={styles.row} testID="home.snoozeCustom">
          <Text style={styles.label}>{t('devices.list.menu.inbox.custom')}</Text>
        </Pressable>
      </>}
      {model.invalid && <Text accessibilityRole="alert" style={styles.error}>{t('devices.list.menu.inbox.invalidTime')}</Text>}
    </View>
  </SessionActionSheetFrame>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, padding: spacing.md },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, color: colors.textPrimary, padding: spacing.sm },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, padding: spacing.sm },
  label: { flexShrink: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  time: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: colors.textSecondary },
  error: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary, padding: spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm },
  pressed: { opacity: 0.72 },
});
