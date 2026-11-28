import { useTeammateInboxEntries } from '@/features/bots/useTeammateInboxEntries';
import { TaskInbox, type TaskInboxProps } from './TaskInbox';

const NONE: [] = [];

/**
 * The inbox with the teammates' main conversations. Search and filters narrow tasks only, so a
 * filtered inbox lists none of them; the teammate section and its search still reach every one.
 */
export function TaskInboxWithTeammates(props: Omit<TaskInboxProps, 'teammates'>) {
  const teammates = useTeammateInboxEntries();
  return <TaskInbox {...props} teammates={props.contentFiltered ? NONE : teammates} />;
}
