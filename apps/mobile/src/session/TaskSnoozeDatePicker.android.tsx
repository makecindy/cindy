import { Host } from '@expo/ui';
import { DateTimePicker, Column } from '@expo/ui/jetpack-compose';
import { useTheme } from '@/theme';
import type { TaskSnoozeDatePickerProps } from './TaskSnoozeDatePicker';

export function TaskSnoozeDatePicker({ date, onChange, minimumDate, maximumDate }: TaskSnoozeDatePickerProps) {
  const { mode, colors } = useTheme();
  const initial = date ?? minimumDate;
  const day = new Date(Date.UTC(initial.getFullYear(), initial.getMonth(), initial.getDate()));
  return <Host matchContents={{ vertical: true }} colorScheme={mode} seedColor={colors.textPrimary}>
    <Column>
      <DateTimePicker initialDate={day.toISOString()} displayedComponents="date"
        selectableDates={{ start: minimumDate, end: maximumDate }} showTitle={false}
        onDateSelected={value => {
          if (!value) return onChange(null);
          const next = new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), initial.getHours(), initial.getMinutes());
          if (next.getTime() !== date?.getTime()) onChange(next);
        }} />
      <DateTimePicker initialDate={initial.toISOString()} displayedComponents="hourAndMinute" variant="input"
        onDateSelected={value => {
          if (!value) return onChange(null);
          const next = new Date(initial);
          next.setHours(value.getHours(), value.getMinutes(), 0, 0);
          if (next.getTime() !== date?.getTime()) onChange(next);
        }} />
    </Column>
  </Host>;
}
