import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Host } from '@expo/ui';
import { DatePickerDialog, TimePickerDialog } from '@expo/ui/jetpack-compose';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles } from '@/theme';
import { makeTodoStyles } from './companionTodoStyles';
import type { TodoDateInputProps } from './TodoDateInput';
export function TodoDateInput({ label, value, kind, onChange }: TodoDateInputProps) {
  const [part, setPart] = useState<'date' | 'time' | null>(null),
    { mode, colors } = useTheme(),
    styles = useThemedStyles(makeTodoStyles);
  const chooseDate = (d: Date) => {
    const merged = new Date(value);
    merged.setFullYear(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    onChange(merged);
    setPart(null);
  };
  const chooseTime = (d: Date) => {
    const merged = new Date(value);
    merged.setHours(d.getHours(), d.getMinutes(), 0, 0);
    onChange(merged);
    setPart(null);
  };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setPart(kind === 'time' ? 'time' : 'date')}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {kind === 'date'
            ? value.toLocaleDateString()
            : kind === 'time'
              ? value.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : value.toLocaleString()}
        </Text>
      </Pressable>
      {kind === 'datetime' && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => setPart('time')}
          style={styles.button}
        >
          <Text style={styles.buttonText}>
            {value.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </Pressable>
      )}
      {part && (
        <Host colorScheme={mode} seedColor={colors.textPrimary} matchContents>
          {part === 'date' ? (
            <DatePickerDialog
              initialDate={new Date(
                Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
              ).toISOString()}
              onDateSelected={chooseDate}
              onDismissRequest={() => setPart(null)}
            />
          ) : (
            <TimePickerDialog
              initialDate={value.toISOString()}
              onDateSelected={chooseTime}
              onDismissRequest={() => setPart(null)}
            />
          )}
        </Host>
      )}
    </View>
  );
}
