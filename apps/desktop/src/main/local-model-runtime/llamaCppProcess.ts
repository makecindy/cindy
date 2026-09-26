/** The pipe is held only by Cindy. EOF after SIGKILL/crash kills this owned
 * process group, including router model children. No persisted PID is trusted.
 * Arguments are positional, never interpolated into shell source. */
export const LLAMACPP_OWNER_GUARD = `
exec 3<&0
"$@" 3<&- </dev/null &
server=$!
(/bin/cat <&3 >/dev/null; kill -KILL -$$) &
trap 'kill -TERM "$server" 2>/dev/null; wait "$server"; kill -KILL -$$' TERM INT
wait "$server"
kill -KILL -$$
`;

export function llamaCppProcessCommand(
  binary: string,
  args: string[],
  platform = process.platform,
) {
  return platform === 'win32'
    ? { binary, args }
    : { binary: '/bin/sh', args: ['-c', LLAMACPP_OWNER_GUARD, 'cindy-llamacpp', binary, ...args] };
}
