import { startThreadControlFlow as startSharedThreadControlFlow } from '@cindy/im-runtime/controlFlow';
import type { ImCommandHost } from '@cindy/im-runtime/commandHost';
import { createLogger } from '../../logger';
import { listProjectsForControl } from './controlProjects';
import { enterControl } from './controlState';

export const startThreadControlFlow: ImCommandHost['startThreadControlFlow'] = (
  im,
  adapter,
  cards,
  args,
) =>
  startSharedThreadControlFlow(im, adapter, cards, args, {
    createLogger: (...args) => createLogger(...args),
    listProjectsForControl: () => listProjectsForControl(),
    enterControl: (...args) => enterControl(...args),
  });
