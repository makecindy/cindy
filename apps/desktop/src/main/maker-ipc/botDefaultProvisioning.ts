import fs from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

export async function markDefaultBotOffered(ownerRoot: string): Promise<void> {
  const receipt = path.join(ownerRoot, 'bots', '.initial-companion');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  try { await fs.writeFile(receipt, '1\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** Initialization and deletion must serialize on the captured owner's receipt. */
export async function withDefaultBotProvisioningLock<T>(
  ownerRoot: string,
  assertOwner: () => void,
  action: () => Promise<T>,
): Promise<T> {
  assertOwner();
  const receipt = path.join(ownerRoot, 'bots', '.initial-companion');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  return withCrossProcessLock(`${receipt}.lock`, { label: 'initial-companion' }, async lock => {
    if (!lock.held) throw new Error(`Default teammate initialization lock ${lock.reason}`);
    assertOwner();
    return action();
  });
}

/** One-time onboarding receipt, deliberately outside any deletable Bot Home. */
export async function provisionDefaultBot(input: {
  ownerRoot: string;
  assertOwner: () => void;
  hasBotHistory: () => Promise<boolean>;
  create: () => Promise<unknown>;
}): Promise<void> {
  input.assertOwner();
  const receipt = path.join(input.ownerRoot, 'bots', '.initial-companion');
  await withDefaultBotProvisioningLock(input.ownerRoot, input.assertOwner, async () => {
    try {
      await fs.access(receipt);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Existing users keep their roster, including a decision to remove Cindy.
    // A receipt survives later deletion of every profile and its history.
    const existing = await input.hasBotHistory();
    input.assertOwner();
    if (!existing) await input.create();
    input.assertOwner();
    await markDefaultBotOffered(input.ownerRoot);
  });
}
