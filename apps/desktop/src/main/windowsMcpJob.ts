import { createWindowsHelperResolver, type WindowsHelperPaths } from './windowsRustHelper.js';

const binaryName = 'cindy-mcp-stdio-job.exe';
let resolveBinary = createWindowsHelperResolver(binaryName);

export function configureWindowsMcpJob(paths: WindowsHelperPaths): void {
  resolveBinary = createWindowsHelperResolver(binaryName, paths);
}

export function resolveWindowsMcpJob(): Promise<string> {
  return resolveBinary();
}
