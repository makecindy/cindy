import { createWindowsRustHelper } from './windowsRustHelper.js';

export const { configure: configureWindowsMcpJob, resolve: resolveWindowsMcpJob } =
  createWindowsRustHelper('cindy-mcp-stdio-job.exe');
