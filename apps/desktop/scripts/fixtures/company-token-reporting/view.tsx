import { CompanyTokenSettings } from '../../../src/renderer/components/settings/usage/CompanyTokenReporting';
import { mountPage } from '../../ui-page/harness';

void mountPage({
  host: () => {
    let participating = true;
    return {
      companyTokenView: async () => ({ generation: 1, participating, needsNotice: false }),
      companyTokenParticipation: async (next: boolean) => { participating = next; },
    };
  },
  render: () => <main className="p-4"><CompanyTokenSettings /></main>,
});
