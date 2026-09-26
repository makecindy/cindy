import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { GithubSetupDialog } from './GithubSetupDialog';

/** Local GitHub connection entry shared by feature pages. */
export function GithubConnectButton({
  onConnected,
  visible = true,
}: {
  onConnected?(): void;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      {visible && (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t('ccAgent.gitContext.pr.setup.stages.login.title')}
        </Button>
      )}
      {open && <GithubSetupDialog onClose={() => setOpen(false)} onConnected={onConnected} />}
    </>
  );
}
