import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import {
  buildSessionComposerLayout as buildSessionComposerLayoutShared,
} from '@cindy/maker-shared/session-operation';
import type { SessionComposerLayoutInput } from '@cindy/maker-shared/session-operation';

export {
  type SessionComposerLayout,
  type SessionComposerLayoutInput,
  type SessionComposerPrimaryAction,
} from '@cindy/maker-shared/session-operation';

export function buildSessionComposerLayout(input: SessionComposerLayoutInput) {
  return buildSessionComposerLayoutShared(input, mobilePresentationLocalizer);
}
