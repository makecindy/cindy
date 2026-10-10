import { Host } from '@expo/ui';
import { DatePicker } from '@expo/ui/swift-ui';
import { datePickerStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/theme';
import type { TodoDateInputProps } from './TodoDateInput';
export function TodoDateInput({ label, value, kind, onChange }: TodoDateInputProps) {
  const { mode } = useTheme();
  return (
    <Host colorScheme={mode} matchContents style={{ minHeight: 44 }}>
      <DatePicker
        title={label}
        selection={value}
        displayedComponents={
          kind === 'datetime'
            ? ['date', 'hourAndMinute']
            : kind === 'time'
              ? ['hourAndMinute']
              : ['date']
        }
        onDateChange={onChange}
        modifiers={[datePickerStyle('compact'), frame({ height: 44 })]}
      />
    </Host>
  );
}
