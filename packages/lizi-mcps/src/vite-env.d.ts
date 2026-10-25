// Local Vite-style declarations. @cindy/mcps already requires Vite at build/test
// time (uses `?raw` imports); we declare the bits we use rather than depending
// on `vite/client` so the package types stay self-contained.

declare module '*.md?raw' {
  const content: string;
  export default content;
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: {
      eager?: boolean;
      query?: string;
      import?: string;
    },
  ): Record<string, T>;
}
