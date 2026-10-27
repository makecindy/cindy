import { AppFrame, ctx, mountPage } from '../../ui-page/harness';
import { TeammatesSection } from '../../../src/renderer/features/bots/TeammatesSection';

// The production sidebar lives in the shell, outside child route elements.
mountPage({
  route: ctx.data.route as string,
  render: () => <AppFrame header={false} sidebar={<TeammatesSection />} />,
});
