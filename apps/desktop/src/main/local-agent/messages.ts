import { t } from '../i18n.js';

/** Localize product copy at the host boundary; stable wire codes stay untranslated. */
export function localAgentMessage(code: string): string {
  let key: string;
  switch (code) {
    case 'HOST_IN_USE':
      key = 'hostInUse';
      break;
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      key = 'authorizationRequired';
      break;
    case 'PAIR_EXPIRED':
      key = 'pairExpired';
      break;
    case 'BUSY':
    case 'SESSION_STARTING':
      key = 'busy';
      break;
    case 'GRANT_LIMIT':
    case 'CLIENT_LIMIT':
    case 'RESUME_LIMIT':
      key = 'limitReached';
      break;
    case 'INVALID_WORKSPACE':
      key = 'invalidWorkspace';
      break;
    case 'SESSION_EXISTS':
      key = 'sessionExists';
      break;
    case 'SESSION_UNAVAILABLE':
    case 'RESUME_UNAVAILABLE':
    case 'TOOL_UNAVAILABLE':
    case 'NOT_RUNNING':
      key = 'executionUnavailable';
      break;
    case 'MODEL_UNAVAILABLE':
    case 'MODEL_CHANGED':
    case 'INVALID_EFFORT':
      key = 'selectionUnavailable';
      break;
    case 'INSTANCE_CHANGED':
    case 'ID_REUSED':
    case 'REQUEST_EXPIRED':
      key = 'requestNotReplayed';
      break;
    case 'GRANT_STORE_INVALID':
    case 'DISCOVERY_UNAVAILABLE':
      key = 'storageUnavailable';
      break;
    case 'RUNTIME_CLOSE_UNCONFIRMED':
      key = 'stopUnconfirmed';
      break;
    case 'INTERACTION_UNAVAILABLE':
      key = 'interactionUnavailable';
      break;
    case 'INTERRUPTED':
      key = 'interrupted';
      break;
    case 'TOOL_TIMEOUT':
      key = 'toolTimeout';
      break;
    case 'CONNECT_RESULT':
      key = 'connectResult';
      break;
    case 'INVALID_REQUEST':
    case 'INVALID_REQUEST_ID':
    case 'INVALID_CLIENT':
    case 'INVALID_INPUT':
    case 'INVALID_IMAGE':
    case 'INVALID_CURSOR':
    case 'TOO_LARGE':
    case 'UNSUPPORTED_ACCESS':
    case 'UNSUPPORTED_COMMAND':
    case 'METHOD_UNSUPPORTED':
    case 'PROTOCOL_UNSUPPORTED':
      key = 'invalidRequest';
      break;
    default:
      key = 'operationFailed';
  }
  return t(`localAgent.${key}`);
}
