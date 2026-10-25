import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import { bindingStore } from '../im/binding.js';
import { assertTaskActionCurrent } from '../maker-ipc/taskActionAuthorization.js';
import {
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
  withLocalProjectContext,
} from './createProject.js';
import { createProjectMove } from '@cindy/app-runtime/moveSession';
export const { createMoveSession, moveSessionProjectFromHost } = createProjectMove({
  updateSessionInDb,
  bindingStore,
  assertTaskActionCurrent,
  validateExistingLocalProjectDirectory,
  validateLocalProjectDirectory,
  withLocalProjectContext,
});
