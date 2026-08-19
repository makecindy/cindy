/** DSH provider-request identity shared by diagnostics and model discovery. */
import dshAdapterPackage from '@deepseek-ai/dsh-llm-deepseek/package.json' with { type: 'json' };

/**
 * The published DSH packages are versioned as one suite. The DeepSeek adapter is a direct Desktop
 * dependency, so its manifest is the stable local source for the suite version without adding a
 * second dependency on the provider-neutral package solely to format this header.
 */
export const DSH_PROVIDER_USER_AGENT =
  `deepseek-harness/${dshAdapterPackage.version} (+https://github.com/deepseek-ai/deepseek-harness)`;
