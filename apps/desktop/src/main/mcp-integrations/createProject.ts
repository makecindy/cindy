// Compatibility entry for existing Desktop callers; business logic is shared with Node Host.
export { createProject } from './projectTools.desktop.js';
export {
  withLocalProjectContext,
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
  type LocalProjectContext,
} from './createProjectCore.js';
