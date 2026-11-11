import { createHash } from 'node:crypto';
import type { AppearanceSettings } from '../../shared/appearanceSettings.js';

/** Shared by both plugin parameter formats while the existing settings lock is held. */
export const pluginAppearanceRevision = (value: AppearanceSettings) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
