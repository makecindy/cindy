import { TextInput } from '@/components/AppText';
import { parseTaskSnoozeTime, toLocalDateTimeValue } from '@cindy/maker-shared/task-snooze-options';
export interface TaskSnoozeDatePickerProps {
  date: Date | null;
  onChange(date: Date | null): void;
  minimumDate: Date;
  maximumDate: Date;
}
/** Web fallback. Native platforms use their system date/time controls. */
export function TaskSnoozeDatePicker({ date, onChange, minimumDate }: TaskSnoozeDatePickerProps) {
  return <TextInput defaultValue={date ? toLocalDateTimeValue(date) : ''}
    onChangeText={value => onChange(parseTaskSnoozeTime(value, minimumDate.getTime()))} />;
}
