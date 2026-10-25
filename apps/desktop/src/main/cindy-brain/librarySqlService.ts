import * as path from 'node:path';
export * from '@cindy/plugin-runtime/library/librarySqlService';

/** 生产 worker 脚本路径(构建产物与 main 输出同目录;见 forge vite 配置)。 */
export function defaultLibraryDbWorkerPath(): string {
  return path.join(__dirname, 'libraryDbWorker.js');
}
