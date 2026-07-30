/**
 * Shim: openclaw/plugin-sdk/media-understanding-runtime.
 *
 * `describeImageFile` (LLM screenshot description for text-only models) is only
 * referenced by the dropped `sdk-setup-tools` bridge re-export and is never
 * called on the in-process dispatcher path. Cindy performs its own image
 * understanding upstream of this runtime, so this is a host-injectable hook
 * that defaults to a clear "not configured" result.
 */
export type DescribeImageFn = (filePath: string, prompt?: string) => Promise<string>;

let describeImpl: DescribeImageFn | null = null;

/** Host hook: wire Cindy image-understanding here if screenshot description is wanted. */
export function setDescribeImageFile(fn: DescribeImageFn | null): void {
  describeImpl = fn;
}

export async function describeImageFile(filePath: string, prompt?: string): Promise<string> {
  if (describeImpl) return describeImpl(filePath, prompt);
  return '[image description not configured]';
}
