declare module '*.md?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(pattern: string, options?: Record<string, unknown>): Record<string, unknown>;
}
