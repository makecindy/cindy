// vitest 全局兜底 mock:expo-file-system/legacy 的真模块在 SDK 58 会拖 react-native 依赖链
// (Flow 语法,node 环境解析失败),且与同文件里已 vi.mock 的懒加载 import 并发时会漏到真模块。
// 需要控制文件系统的测试仍用 vi.mock 按用例覆盖,vi.mock 优先于本 alias。
const unavailable = (name: string) => async (): Promise<never> => {
  throw new Error(`expo-file-system/legacy.${name} is not available in unit tests; mock it with vi.mock`);
};

export const documentDirectory: string | null = null;
export const cacheDirectory: string | null = null;
export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;
export const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 } as const;
export const FileSystemSessionType = { BACKGROUND: 0, FOREGROUND: 1 } as const;
export const copyAsync = unavailable('copyAsync');
export const deleteAsync = unavailable('deleteAsync');
export const downloadAsync = unavailable('downloadAsync');
export const getInfoAsync = unavailable('getInfoAsync');
export const makeDirectoryAsync = unavailable('makeDirectoryAsync');
export const moveAsync = unavailable('moveAsync');
export const readAsStringAsync = unavailable('readAsStringAsync');
export const readDirectoryAsync = unavailable('readDirectoryAsync');
export const writeAsStringAsync = unavailable('writeAsStringAsync');
export const createDownloadResumable = unavailable('createDownloadResumable');
export const createUploadTask = unavailable('createUploadTask');
