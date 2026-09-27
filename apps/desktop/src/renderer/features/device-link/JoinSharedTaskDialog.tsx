import { SharedTaskDialog } from './SharedTaskDialog';

export function JoinSharedTaskDialog(props: { open: boolean; onOpenChange(open: boolean): void }) {
  return <SharedTaskDialog {...props} />;
}
