/** Remove Git's record terminator, never whitespace belonging to a path. */
export function gitPathOutput(stdout: string): string {
  return stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
}
