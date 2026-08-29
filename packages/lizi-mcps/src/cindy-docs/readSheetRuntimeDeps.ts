/**
 * read_sheet 的 XLSX worker 通过 createRequire() 在运行期加载这两个包。
 * Vite 不会把 worker 字符串里的 require 依赖收进 main bundle，因此 Desktop
 * 正式包必须显式携带它们以及各自的完整 dependencies 闭包。
 */
export const READ_SHEET_RUNTIME_PACKAGES = ['jszip', 'exceljs'] as const;
