import {net} from 'electron';
import * as authManager from './authManager';
import {getResolvedMainLocale} from './i18n.js';
import {createLogger} from './logger';
import {requestErrorMessage} from './requestErrorMessage';
import {createServerApiClient} from '@cindy/app-runtime/serverApiClient';
export {ServerApiError,type ApiFetchOptions} from '@cindy/app-runtime/serverApiClient';
export const {serverApiFetch}=createServerApiClient({authManager,getResolvedMainLocale,requestErrorMessage,logger:createLogger('serverApiClient'),fetch:(url,init)=>net.fetch(url instanceof URL ? url.toString() : url,init)});
