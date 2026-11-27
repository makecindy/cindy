/** 防止超大输出炸内存。listBranches/listFiles 这类正常情况远低于此。 */
export const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * For listings that grow with the whole index or tree (`ls-files`, `ls-tree -r`, `diff-files`).
 * A repository with ~1M tracked files prints 100+ MB here; the default ceiling made every such
 * call fail. Kept below V8's ~512M-character string limit so the decoded output still fits.
 */
export const GIT_LISTING_MAX_BUFFER = 256 * 1024 * 1024;
