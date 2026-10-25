import { createLogger } from '../logger';
import { createCodexHistoryPromptInit } from '@cindy/runtime-db/codexHistoryPromptInit';
export const { initializeCodexHistoryPromptState } = createCodexHistoryPromptInit(createLogger('localDb/codex-history-prompt-init'));
export { CODEX_PRODUCT_PROMPT_REVISION } from '@cindy/runtime-db/codexHistoryPromptInit';
