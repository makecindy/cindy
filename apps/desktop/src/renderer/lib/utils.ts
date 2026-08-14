import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            '10',
            '11',
            '12',
            '13',
            '14',
            '15',
            '16',
            '18',
            '20',
            '24',
            '28',
          ],
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
