import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';
import type { RoutingDescriptor } from '@cindy/model-providers';

/** Bind both JSON and multipart image requests to the selected Provider's deployment. */
export function createCodexImageModelRewrite(
  binding: NonNullable<RoutingDescriptor['imageModel']>,
): NonNullable<RoutingDecision['transformRequestBody']> {
  const { wireModel, litellmModel, supportsEdit } = binding;
  return async (body, ctx) => {
    if (!supportsEdit && ctx.url.split('?', 1)[0]?.endsWith('/images/edits')) {
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
        !('model' in parsed) ||
        parsed.model !== wireModel
      ) {
        throw new Error('Image request does not match the Provider binding');
      }
      return { body: Buffer.from(JSON.stringify({ ...parsed, model: litellmModel })) };
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
      if (form.getAll('model').length !== 1 || form.get('model') !== wireModel) {
        throw new Error('Image request does not match the Provider binding');
      }
      form.set('model', litellmModel);
      const encoded = new Response(form);
      return {
        body: Buffer.from(await encoded.arrayBuffer()),
        contentType: encoded.headers.get('content-type')!,
      };
    }
    throw new Error('Unsupported image request content type');
  };
}
