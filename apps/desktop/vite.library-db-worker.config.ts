import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      // library db worker 是 Node worker_threads 运行时,原生模块必须在
      // packaged app 的 node_modules / asar.unpacked 中按平台解析,不能被
      // Vite bundle(与 vite.db-worker.config.ts 同约束)。
      external: ['better-sqlite3'],
    },
  },
});
