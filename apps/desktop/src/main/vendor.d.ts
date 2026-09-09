// Type declarations for vendor modules without bundled types
declare module 'js-yaml' {
  const yaml: {
    load(input: string): unknown;
    dump(obj: unknown): string;
  };
  export default yaml;
}

// Vite `?raw` import — bundles the file content as a string literal at build time.
// Used by systemPromptLoader.ts to inline xdt-maker-system-prompt.md.
declare module '*.md?raw' {
  const content: string;
  export default content;
}

declare module '*.cjs?raw' {
  const content: string;
  export default content;
}
