import { requestResponse } from './http.js';
import { configureDefaultDownloadRequest } from './transportCore.js';
configureDefaultDownloadRequest(async (url, init) => ({ response: await requestResponse(url, init) }));
export * from './transportCore.js';
