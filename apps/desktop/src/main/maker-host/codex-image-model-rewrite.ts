import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';
import type { RoutingDescriptor } from '@cindy/model-providers';

/** Check image grants and bind JSON/multipart requests to the selected deployment. */
export function createCodexImageModelRewrite(
  binding: RoutingDescriptor['imageModel'],
  allowsModel?: (model: string) => boolean | Promise<boolean>,
): NonNullable<RoutingDecision['transformRequestBody']> {
  const checkModel = async (model: unknown): Promise<void> => {
    if (typeof model !== 'string' || !model || (binding && model !== binding.wireModel)) {
      throw new Error('Image request does not match the Provider binding');
    }
    if (allowsModel && !await allowsModel(binding?.litellmModel ?? model)) {
      throw new Error('Image model is not available for this remote task');
    }
  };
  return async (body, ctx) => {
    if (binding && !binding.supportsEdit && ctx.url.split('?', 1)[0]?.endsWith('/images/edits')) {
      throw new Error('Image editing is not supported by this Provider binding');
    }
    const encoding = ctx.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') {
      throw new Error('Unsupported image request encoding');
    }
    const contentType = ctx.headers['content-type'] ?? '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (mediaType === 'application/json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new Error('Invalid image request JSON');
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !('model' in parsed)
      ) {
        throw new Error('Image request does not match the Provider binding');
      }
      await checkModel(parsed.model);
      return binding ? { body: Buffer.from(JSON.stringify({ ...parsed, model: binding.litellmModel })) } : { body };
    }
    if (mediaType === 'multipart/form-data') {
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(body), {
          headers: { 'content-type': contentType },
        }).formData();
      } catch {
        throw new Error('Invalid image request multipart body');
      }
      if (form.getAll('model').length !== 1) {
        throw new Error('Image request does not match the Provider binding');
      }
      await checkModel(form.get('model'));
      if (!binding) return { body };
      form.set('model', binding.litellmModel);
      const encoded = new Response(form);
      return {
        body: Buffer.from(await encoded.arrayBuffer()),
        contentType: encoded.headers.get('content-type')!,
      };
    }
    throw new Error('Unsupported image request content type');
  };
}
