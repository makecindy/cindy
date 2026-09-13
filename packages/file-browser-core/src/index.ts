/**
 * @cindy/file-browser-core — workdir 文件浏览的共享核心。
 *
 * 同一份实现跑在两种宿主里:
 *   - desktop main:file-browser IPC 的 LocalBackend(本地会话)
 *   - 远端 file-service daemon:SSH remote 会话的执行端(esbuild 打包后
 *     跑在 ~/.xdt-server/v1/node/ 的 bundled Node 上)
 *
 * 因此本包必须保持:零 Electron 依赖、零原生模块依赖(prebuilt .node 进不了
 * daemon bundle)、所有宿主差异(logger / rgPath / 窗口生命周期)由调用方注入。
 * 见 eslint.config.mjs 的 no-restricted-imports 强制约束。
 */

export {
  setFileBrowserCoreLoggerFactory,
  scopedLogger,
  type CoreLogger,
  type CoreLoggerFactory,
} from './logging.js';

export {
  listDir,
  listRoot,
  readFile,
  readFileChunk,
  FILE_CHUNK_MAX_LENGTH,
  writeFile,
  writeNewFile,
  verifyNewFile,
  eraseIfSame,
  releaseNewFile,
  chooseStagingDir,
  NewFileHoldRegistry,
  type NewFileIdentity,
  createFile,
  createFolder,
  renameEntry,
  deleteEntry,
  statEntry,
  XDT_TMP_SUFFIX,
  type DirEntry,
  type FileReadResult,
  type FileChunkResult,
  type FileStat,
  type ListDirOptions,
} from './scanner.js';

export {
  loadIgnoreMatcher,
  __clearCacheForTesting,
  type Matcher,
} from './ignore.js';

export {
  listAllFiles,
  listAllFilesWalk,
  LIST_ALL_FILES_CAP,
  type ListAllFilesArgs,
  type ListAllFilesWalkArgs,
  type ListAllFilesResult,
} from './listAllFiles.js';

export {
  RipgrepSearcher,
  type RipgrepSearcherOptions,
  type SearcherLogger,
} from './search/RipgrepSearcher.js';

export type {
  SearchQuery,
  SearchMatch,
  SearchEnd,
  SearchError,
  SearchEvent,
  SubmatchSpan,
} from './search/types.js';

export {
  SUPPORTED_TEXT_EXTS,
  COMPOUND_EXTS,
  KNOWN_TEXT_FILENAMES,
} from './textFileExts.js';
