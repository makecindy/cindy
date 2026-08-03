/**
 * Desktop attachment safety policy shared by renderer and main.
 *
 * These extensions can execute code, install software, or redirect to another
 * executable when opened by the operating system. They must stay download-only
 * in chat and are staged under an inert `.bin` cache name before sending.
 */
const DANGEROUS_ATTACHMENT_EXTS = new Set([
  // Windows executables / installers / control-panel payloads.
  '.exe',
  '.msi',
  '.msp',
  '.msu',
  '.msix',
  '.msixbundle',
  '.appx',
  '.appxbundle',
  '.com',
  '.scr',
  '.cpl',
  '.pif',
  '.hta',
  '.js',
  '.jse',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.reg',
  '.application',
  '.appref-ms',
  '.gadget',
  // macOS installers / application bundles and executable command files.
  '.dmg',
  '.pkg',
  '.app',
  '.command',
  // Script launchers commonly associated with direct execution.
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.py',
  '.pyw',
  '.pl',
  '.rb',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.run',
  '.appimage',
  '.deb',
  '.rpm',
  '.apk',
  // Runtime packages and shortcuts that may launch code or another target.
  '.jar',
  '.jnlp',
  '.lnk',
  '.scf',
  '.desktop',
  '.url',
]);

export function attachmentExtension(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function isDangerousAttachmentName(name: string): boolean {
  return DANGEROUS_ATTACHMENT_EXTS.has(attachmentExtension(name));
}

export const __attachmentSafetyTesting = { DANGEROUS_ATTACHMENT_EXTS };
