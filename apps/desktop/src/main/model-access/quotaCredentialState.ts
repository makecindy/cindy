import type { AuthState } from '../authManager.js';
import type { ModelAccessStatus } from '../../shared/modelAccess.js';
import {createQuotaCredentialState} from '@cindy/app-runtime/quotaCredentialState';
export const {noteQuotaCredentialStatus,quotaCredentialsReady,quotaCredentialGeneration,onQuotaCredentialSourceChanged,cloudQuotaOwnerKey,setQuotaCredentialStatusReader,__resetQuotaCredentialStateForTesting,refreshQuotaCredentialOwner}=createQuotaCredentialState({});
