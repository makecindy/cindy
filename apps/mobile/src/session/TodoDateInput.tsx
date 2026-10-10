import { TextInput } from '@/components/AppText';
import { useThemedStyles } from '@/theme';
import { makeTodoStyles } from './companionTodoStyles';
export interface TodoDateInputProps {
  label: string;
  value: Date;
  kind: 'date' | 'time' | 'datetime';
  onChange(date: Date): void;
}
/** Web fallback; native platforms use the existing Expo UI date/time controls. */
export function TodoDateInput({ label, value, onChange }: TodoDateInputProps) {
  const styles = useThemedStyles(makeTodoStyles);
  return (
    <TextInput
      accessibilityLabel={label}
      style={styles.input}
      value={value.toLocaleString()}
      onChangeText={(text) => {
        const date = new Date(text);
        if (Number.isFinite(date.getTime())) onChange(date);
      }}
    />
  );
}
