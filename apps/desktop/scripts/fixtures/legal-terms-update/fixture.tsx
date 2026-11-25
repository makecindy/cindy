import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { LegalTermsUpdateGate } from '../../../src/renderer/components/auth/LegalTermsUpdateGate';

const payload = (legalTermsUpdateRequired: boolean) => ({
  privacyConsentAccepted: true,
  analyticsEnabled: true,
  analyticsEnabledCustomized: false,
  allowed: false,
  legalTermsUpdateRequired,
});

function Background() {
  return (
    <AppFrame sidebar={<div className="p-4 text-13 text-[var(--text-secondary)]">Tasks</div>}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10">
        <h1 className="text-xl font-medium">What should Cindy do today?</h1>
        <textarea
          aria-label="Describe a task"
          className="h-24 w-[560px] max-w-full rounded-xl border border-[var(--border-default)] bg-transparent p-3 text-14"
          defaultValue="Draft the weekly gift card report"
        />
      </div>
    </AppFrame>
  );
}

mountPage({
  route: '/cc-agent/new',
  host: () => ({
    getAnalyticsSettings: async () => payload(true),
    onAnalyticsSettingsChange: subscription('analyticsSettingsChange'),
    acceptLegalTermsUpdate: async () => payload(false),
    openExternal: async () => ({ success: true }),
  }),
  render: () => (
    <>
      <Background />
      <LegalTermsUpdateGate />
    </>
  ),
});
