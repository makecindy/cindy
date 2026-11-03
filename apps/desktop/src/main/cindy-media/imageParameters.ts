/** Image options shared by the invocation guide and the actual provider serializers. */
export type ImageProtocol = 'openai' | 'gemini' | 'xai';
export interface ImageParameters {
  aspectRatio?: string;
  size?: string;
  resolution?: string;
  quality?: string;
}

const LEGACY_SIZES: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};
const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const XAI_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
  '21:9',
  '5:2',
];
const SIZE_RULE =
  'size must have edges divisible by 16, each <= 3840, aspect ratio <= 3:1, and 655360–8294400 total pixels. Use a supported generation size, then resize separately if exact final dimensions are needed.';
const modelName = (model: string) => model.slice(model.lastIndexOf('/') + 1);
const customSizes = (model: string) => /^gpt-image-2(?:$|\.)/.test(modelName(model));
const oldGptImage = (model: string) => /^gpt-image-1(?:$|[.-])/.test(modelName(model));

function choices(values: string[], description?: string): Record<string, unknown> {
  return { type: 'string', enum: values, ...(description ? { description } : {}) };
}

/** Protocol comes from the selected execution channel, never inferred from account IDs. */
export function imageParameterSchema(
  protocol: ImageProtocol | undefined,
  model: string,
): Record<string, Record<string, unknown>> {
  if (!protocol) return { aspect_ratio: choices(Object.keys(LEGACY_SIZES)) };
  if (protocol === 'openai') {
    return {
      aspect_ratio: {
        type: 'string',
        description:
          'Optional width:height ratio. Prefer size for exact dimensions; do not combine conflicting size and ratio.',
      },
      size: oldGptImage(model)
        ? choices(['auto', ...Object.values(LEGACY_SIZES)])
        : {
            type: 'string',
            description: customSizes(model)
              ? `auto or WIDTHxHEIGHT. ${SIZE_RULE}`
              : 'auto or WIDTHxHEIGHT, subject to the selected model limits.',
          },
      quality: choices(
        /^gpt-image-2\.5(?:-|$)/.test(modelName(model))
          ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
          : ['auto', 'low', 'medium', 'high'],
        'draft → low; standard → medium; best → highest supported quality. Omit when unspecified.',
      ),
    };
  }
  if (protocol === 'gemini') {
    const name = modelName(model);
    const flash31 = /^gemini-3\.1-flash-image/.test(name);
    const fixed1k = /^gemini-2\.5-/.test(name);
    return {
      aspect_ratio: choices([...GEMINI_RATIOS, ...(flash31 ? ['1:4', '4:1', '1:8', '8:1'] : [])]),
      ...(!fixed1k
        ? {
            resolution: choices(
              [...(flash31 ? ['512'] : []), '1K', '2K', '4K'],
              'Maps to imageConfig.imageSize. Preserve an explicit resolution; for quality intent use draft/standard → 1K and best → highest supported resolution.',
            ),
          }
        : {}),
    };
  }
  return {
    aspect_ratio: choices(XAI_RATIOS),
    resolution: choices(
      ['1k', '2k'],
      'draft/standard → 1k; best → 2k unless an explicit resolution was requested.',
    ),
    ...(modelName(model) === 'grok-imagine-image-2.0'
      ? { quality: choices(['auto', 'low', 'medium'], 'draft → low; standard/best → medium.') }
      : {}),
  };
}

function validateSize(model: string, size: string): void {
  if (size === 'auto') return;
  const match = /^(\d{1,6})x(\d{1,6})$/.exec(size);
  if (!match) throw new Error('size must be auto or WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new Error('size dimensions must be positive');
  if (
    customSizes(model) &&
    (width % 16 ||
      height % 16 ||
      Math.max(width, height) > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      width * height < 655360 ||
      width * height > 8294400)
  ) {
    throw new Error(SIZE_RULE);
  }
}

function aspectSize(model: string, aspect: string): string {
  if (aspect === 'auto') return 'auto';
  if (LEGACY_SIZES[aspect]) return LEGACY_SIZES[aspect];
  if (oldGptImage(model))
    throw new Error(
      'This model supports only 1:1, 3:2 and 2:3; choose another model for this aspect ratio.',
    );
  if (!/^\d{1,5}(?:\.\d{1,2})?:\d{1,5}(?:\.\d{1,2})?$/.test(aspect))
    throw new Error('aspect_ratio must be width:height');
  const [a, b] = aspect.split(':').map(Number);
  if (!a || !b) throw new Error('aspect_ratio dimensions must be positive');
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(Math.round(a * 100), Math.round(b * 100));
  const width = (Math.round(a * 100) / divisor) * 16;
  const height = (Math.round(b * 100) / divisor) * 16;
  const multiple = Math.max(1, Math.round(Math.sqrt((1536 * 1024) / (width * height))));
  const size = `${width * multiple}x${height * multiple}`;
  validateSize(model, size);
  return size;
}

/** Reject unsupported explicit options before paying; never silently strip or downscale them. */
export function normalizeImageParameters(
  protocol: ImageProtocol | undefined,
  model: string,
  input: ImageParameters,
): ImageParameters {
  const result: ImageParameters = {};
  const schema = imageParameterSchema(protocol, model);
  for (const key of ['aspectRatio', 'size', 'resolution', 'quality'] as const) {
    let value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 100)
      throw new Error(`${key} must be a nonempty string`);
    value = value.trim();
    if (key === 'resolution')
      value = protocol === 'gemini' ? value.toUpperCase() : value.toLowerCase();
    if (key === 'size') value = value.toLowerCase().replace('×', 'x');
    const field = schema[key === 'aspectRatio' ? 'aspect_ratio' : key];
    if (!field)
      throw new Error(
        `${key} is not supported by this channel; use the parameters from prepare.input_schema.`,
      );
    if (Array.isArray(field.enum) && !field.enum.includes(value))
      throw new Error(`${key} must be one of: ${field.enum.join(', ')}`);
    result[key] = value;
  }
  if (protocol === 'openai') {
    if (result.size) validateSize(model, result.size);
    if (
      result.aspectRatio &&
      result.aspectRatio !== 'auto' &&
      result.size &&
      result.size !== 'auto'
    ) {
      const [w, h] = result.size.split('x').map(Number);
      const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(result.aspectRatio);
      if (
        !ratio ||
        !Number(ratio[1]) ||
        !Number(ratio[2]) ||
        Math.abs(w / h - Number(ratio[1]) / Number(ratio[2])) > 0.001
      ) {
        throw new Error('size and aspect_ratio conflict; use size alone for exact dimensions.');
      }
    }
    if (result.aspectRatio && (!result.size || result.size === 'auto'))
      result.size = aspectSize(model, result.aspectRatio);
    delete result.aspectRatio;
  }
  return result;
}
