import { McpUiResourceTeardownResultSchema } from '@modelcontextprotocol/ext-apps';

const key = 'cindy/composer-attachment';
const failure = code => Object.assign(new Error(code), { code });

/** Add one resource to the local task composer without sending it to the model. */
export function addToComposer(app, input) {
  const capability = app?.getHostCapabilities?.()?.experimental?.[key];
  if (!capability) return Promise.reject(failure('COMPOSER_ATTACHMENT_UNSUPPORTED'));
  if (!input || typeof input !== 'object' || typeof input.uri !== 'string' ||
      typeof input.name !== 'string' || !input.uri || !input.name) {
    return Promise.reject(failure('COMPOSER_ATTACHMENT_INVALID'));
  }
  return app.request({
    method: 'cindy/composer-attachment/add',
    params: { uri: input.uri, name: input.name, requestId: globalThis.crypto?.randomUUID?.() },
  }, McpUiResourceTeardownResultSchema);
}
