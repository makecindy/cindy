/** Runtime packages needed by the externalized Reviewer PDF canvas polyfill. */
export function reviewPdfRuntimePackages(platform: string, arch: string): string[] {
  let binding: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    binding = `@napi-rs/canvas-darwin-${arch}`;
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    binding = `@napi-rs/canvas-win32-${arch}-msvc`;
  } else if (platform === 'linux') {
    if (arch === 'arm' || arch === 'armv7l') {
      binding = '@napi-rs/canvas-linux-arm-gnueabihf';
    } else if (arch === 'x64' || arch === 'arm64') {
      binding = `@napi-rs/canvas-linux-${arch}-gnu`;
    }
  }
  if (!binding) throw new Error(`Unsupported @napi-rs/canvas target: ${platform}-${arch}`);
  return ['@napi-rs/canvas', binding];
}
