export { withContacts, buildJsonResult, CONTACTS_COLLECTION_RULES } from './_shared.js';
export {
  classifyContactsError,
  DuplicateSuspectSignal,
  type ContactsToolError,
  type ContactsToolErrorCode,
} from './errors.js';
export { registerContactsResolveTool, registerContactsSearchTool } from './search.js';
export {
  compactProfile,
  registerContactsGetTool,
  registerContactsListTool,
  registerContactsListGroupsTool,
  registerContactsStatsTool,
} from './read.js';
export {
  registerContactsCreateTool,
  registerContactsUpdateTool,
  registerContactsAddIdentityTool,
  registerContactsRemoveIdentityTool,
  registerContactsAppendEventTool,
  registerContactsRelationTools,
} from './write.js';
export {
  registerContactsDeleteTool,
  registerContactsMergeTool,
  registerContactsPendingSystemAnchorTools,
  registerContactsFindDuplicatesTool,
  registerContactsImportSystemTool,
  registerContactsVcfTools,
  registerContactsExportSystemTool,
  registerContactsGroupTools,
} from './manage.js';
