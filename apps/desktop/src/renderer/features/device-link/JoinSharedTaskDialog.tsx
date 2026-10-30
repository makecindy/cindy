import { SharedTaskDialog } from './SharedTaskDialog';

export function JoinSharedTaskDialog(props: { initialInvitation?: string; open: boolean; onOpenChange(open: boolean): void }) {
  return <SharedTaskDialog {...props} presentation="join" />;
}
