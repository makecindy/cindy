import { requestResponse } from './http.js';
import { configureDefaultDownloadRequest } from './transport.js';
configureDefaultDownloadRequest(async (url, init) => ({ response: await requestResponse(url, init) }));
export * from './transport.js';
