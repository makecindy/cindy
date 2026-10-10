import { Pressable, View } from 'react-native';
import { MoreHorizontal } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { iconSize, useTheme, useThemedStyles } from '@/theme';
import {
  effectiveTodoDeadline,
  todoDateLabel,
  todoOverdue,
  todoVisible,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';
import { makeTodoStyles as makeStyles } from './companionTodoStyles';
/** Fixed text block followed by a date/action/menu rail, shared by every production row. */
export function CompanionTodoRow({
  item: x,
  label,
  locale,
  busy,
  onOpen,
  onAction,
  onDate,
  onMore,
  tr,
}: {
  item: TeammateTodo;
  label: string;
  locale: string;
  busy: boolean;
  onOpen(): void;
  onAction(): void;
  onDate(): void;
  onMore(): void;
  tr(key: string): string;
}) {
  const styles = useThemedStyles(makeStyles),
    { colors } = useTheme();
  return (
    <View style={styles.row} testID="todo-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={x.title}
        onPress={onOpen}
        style={styles.heading}
      >
        <Text numberOfLines={1} style={styles.title}>
          {x.title}
        </Text>
        <Text numberOfLines={1} style={styles.progress}>
          {!todoVisible(x) && x.decision
            ? tr(
                x.decision.kind === 'deleted'
                  ? 'deleted'
                  : x.decision.kind === 'muted'
                    ? 'muted'
                    : 'deferred',
              ) + ' · '
            : ''}
          {x.origin === 'discovered' ? tr('discovered') + ' · ' : ''}
          {x.progress || x.next?.instruction || x.outcome}
        </Text>
      </Pressable>
      <View style={styles.rail}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('deadline')}
          onPress={onDate}
          style={styles.date}
        >
          <Text numberOfLines={1} style={styles.caption}>
            {!effectiveTodoDeadline(x) && x.deadlineCandidate
              ? tr('candidate') + ' '
              : !effectiveTodoDeadline(x) && x.suggestedDate
                ? tr('suggested') + ' '
                : ''}
            {todoDateLabel(x, locale)}
            {todoOverdue(x) && x.status !== 'done' ? ' · ' + tr('overdue') : ''}
          </Text>
        </Pressable>
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: busy }}
          onPress={onAction}
          style={[styles.action, busy && styles.disabled]}
        >
          <Text numberOfLines={1} style={styles.actionText}>
            {label}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('more')}
          onPress={onMore}
          style={styles.icon}
        >
          <MoreHorizontal color={colors.textSecondary} size={iconSize.action} />
        </Pressable>
      </View>
    </View>
  );
}
