export * from '@cindy/app-runtime/extraDirsValidator';
import { validateExtraDirs as validate } from '@cindy/app-runtime/extraDirsValidator';
import { createLogger } from '../logger.js';
const log = createLogger('extra-dirs-validator');
export const validateExtraDirs = (...args: [Parameters<typeof validate>[0], Parameters<typeof validate>[1], Parameters<typeof validate>[2]?]) => validate(args[0], args[1], args[2], log);
