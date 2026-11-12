import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^better-sqlite3$/,
        replacement: path.join(
          configDir,
          'src',
          'main',
          'localDb',
          'dbSlimmingBetterSqlite.ts',
        ),
      },
      {
        find: /^\.\.\/logger$/,
        replacement: path.join(
          configDir,
          'src',
          'main',
          'localDb',
          'dbSlimmingWorkerLogger.ts',
        ),
      },
    ],
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: [
        'sqlite-vec',
        'drizzle-orm/better-sqlite3',
      ],
    },
  },
});
