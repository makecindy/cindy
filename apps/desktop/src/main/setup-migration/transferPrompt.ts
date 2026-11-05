/**
 * The question the other computer asks before copying keys or authorizing an SSH key for a new
 * computer (docs/product-rules/new-device-setup-migration.md). Native dialog on that computer's own
 * screen: it cannot be answered remotely through this request, and closes itself (as a refusal)
 * when nobody answers in time.
 */
import { dialog, type BrowserWindow } from 'electron';

import { t } from '../i18n.js';
import type { SetupTransferPrompt } from './transfer.js';

const MAX_LINES = 12;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function bulletList(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LINES).map((item) => `• ${item}`);
  if (items.length > MAX_LINES) {
    shown.push(fill(t('setupMigration.transfer.prompt.more'), { count: String(items.length - MAX_LINES) }));
  }
  return shown.join('\n');
}

export function setupTransferPromptText(prompt: SetupTransferPrompt): { message: string; detail: string } {
  const sections: string[] = [];
  if (prompt.secrets.length > 0) {
    sections.push(`${t('setupMigration.transfer.prompt.secrets')}\n${bulletList(prompt.secrets)}`);
  }
  if (prompt.ssh) {
    const fingerprint = prompt.ssh.fingerprint
      ? `\n${fill(t('setupMigration.transfer.prompt.sshKey'), { fingerprint: prompt.ssh.fingerprint })}`
      : '';
    sections.push(`${t('setupMigration.transfer.prompt.ssh')}\n${bulletList(prompt.ssh.hosts)}${fingerprint}`);
  }
  sections.push(fill(t('setupMigration.transfer.prompt.code'), { code: prompt.code }));
  sections.push(t('setupMigration.transfer.prompt.notice'));
  return {
    message: fill(t('setupMigration.transfer.prompt.message'), { name: prompt.requester }),
    detail: sections.join('\n\n'),
  };
}

export async function confirmSetupTransfer(
  prompt: SetupTransferPrompt,
  timeoutMs: number,
  parent: BrowserWindow | null,
): Promise<boolean> {
  const { message, detail } = setupTransferPromptText(prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const window = parent && !parent.isDestroyed() ? parent : null;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const options = {
      type: 'warning' as const,
      title: t('setupMigration.transfer.prompt.title'),
      message,
      detail,
      buttons: [t('setupMigration.transfer.prompt.deny'), t('setupMigration.transfer.prompt.allow')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: controller.signal,
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return !controller.signal.aborted && result.response === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
