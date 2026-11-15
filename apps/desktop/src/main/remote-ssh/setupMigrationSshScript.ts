/**
 * Pure parts of the SSH step of new-computer setup (docs/product-rules/new-device-setup-migration.md),
 * kept apart from the Electron-bound pool so the server-side script is tested as it runs.
 */

/** A server on this computer's loopback is that computer itself, not a server to copy. */
export function isLoopbackSshHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value.endsWith('.localhost');
}

/**
 * Appends one public key line read from stdin unless it is already there. POSIX sh only; keeps
 * a file without a final newline intact and never rewrites existing lines.
 */
export const AUTHORIZE_SCRIPT = String.raw`set -eu
umask 077
mkdir -p "$HOME/.ssh"
F="$HOME/.ssh/authorized_keys"
touch "$F"
chmod 700 "$HOME/.ssh" 2>/dev/null || true
chmod 600 "$F" 2>/dev/null || true
KEY=$(cat)
if grep -qxF "$KEY" "$F"; then
  printf 'PRESENT\n'
  exit 0
fi
if [ -s "$F" ] && [ "$(tail -c 1 "$F" | od -An -c | tr -d ' ')" != '\n' ]; then
  printf '\n' >> "$F"
fi
printf '%s\n' "$KEY" >> "$F"
printf 'ADDED\n'
`;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
