import { stderr } from 'node:process';

import { stripSensitiveAnthropicEnv } from '@cindy/maker-core';

import { stripAnthropicEnvPreservingImportDirectory } from '../../desktop/src/main/provider-import/local/sourceEnvironment.js';

// Same boot step as Desktop main/index.ts. main.ts imports this module first,
// so credentials and endpoint overrides inherited from the launching shell are
// gone before any engine, MCP bridge or plugin worker can copy process.env.
const stripped = stripAnthropicEnvPreservingImportDirectory(stripSensitiveAnthropicEnv);
if (stripped.length > 0) {
  stderr.write(`[cindy] stripped user-level Anthropic env: ${stripped.join(', ')}\n`);
}
