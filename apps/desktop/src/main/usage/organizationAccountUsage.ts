import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import type { ClaudeAccountUsageSnapshot } from './claudeAccountUsage.js';
import {createOrganizationAccountUsage} from '@cindy/app-runtime/organizationAccountUsage';
export const {readOrganizationAccountUsage}=createOrganizationAccountUsage({fetchQuota:()=>serverApiFetch<unknown>('/api/model-access/quota',{baseUrl:()=>getClientEndpoint('modelAccessApiBaseUrl'),timeoutMs:8000,redactErrorDetails:true,allowedRedactedErrorCodes:['MODEL_ACCESS_QUOTA_NOT_SUPPORTED']}),isLegacyQuotaError:error=>error instanceof ServerApiError&&(error.statusCode===404||(error.statusCode===501&&error.code==='MODEL_ACCESS_QUOTA_NOT_SUPPORTED'))});
