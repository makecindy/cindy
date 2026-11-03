import { parseAuthorizationUserCode } from '@cindy/device-link';

/** Own only this temporary code; never erase newer user clipboard content. */
export function copyPrivateDeviceCode(
  clipboard: { writeText(value: string): void; readText(): string; clear(): void },
  code: string,
): () => void {
  parseAuthorizationUserCode(code);
  clipboard.writeText(code);
  return () => {
    try {
      if (clipboard.readText() === code) clipboard.clear();
    } catch {
      /* clipboard service closed */
    }
  };
}
