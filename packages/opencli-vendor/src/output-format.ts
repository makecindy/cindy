import { ArgumentError } from './errors.js';

export const OUTPUT_FORMATS = ['table', 'plain', 'json', 'yaml', 'md', 'csv'] as const;

/** Validate before command execution and retain the renderer's existing aliases. */
export function normalizeOutputFormat(value: string): string {
  const format = value === 'yml' ? 'yaml' : value === 'markdown' ? 'md' : value;
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    throw new ArgumentError(`--format must be one of: ${OUTPUT_FORMATS.join(', ')}. Received: ${JSON.stringify(value)}`);
  }
  return format;
}
