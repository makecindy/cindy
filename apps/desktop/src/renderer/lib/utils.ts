import { NUMERIC_TEXT_CLASSES, Z_INDEX_CLASSES } from '../styles/generated/token-mappings';
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: NUMERIC_TEXT_CLASSES,
        },
      ],
      // 层级刻度类（z-modal、z-dropdown…）。不登记的话 tailwind-merge 只认
      // z-10 / z-[N]，共享组件默认层级和调用方传入的层级会同时保留，
      // 最终生效的是 CSS 里排在后面的那条，而不是调用方的那条。
      z: [
        {
          z: Z_INDEX_CLASSES,
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs));
}

/**
 * basename — strip directory components from a filesystem path.
 *
 * Cross-platform: handles both POSIX (`/`) and Windows (`\`) separators in
 * the same string, since paths arriving from the Agent SDK / IPC layer can
 * be either flavour. Returns the input unchanged when no separator is found.
 *
 * Renderer-side helper — the equivalent Node `path.basename` is only
 * available in the main process.
 */
export function basename(filePath: string): string {
  if (!filePath) return filePath;
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
