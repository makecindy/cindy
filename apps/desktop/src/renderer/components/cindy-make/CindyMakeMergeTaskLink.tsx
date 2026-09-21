import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Opening the retained conversation never resumes Git work or recreates its workspace. */
export function CindyMakeMergeTaskLink({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      size="md"
      onClick={() => navigate('/cc-agent/' + encodeURIComponent(sessionId))}
    >
      {t('cindyMake.merge.openTask')}
    </Button>
  );
}
