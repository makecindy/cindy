import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', testTimeout: 10_000, hookTimeout: 10_000 } });
