import {ipcMain} from 'electron';
import {isDeviceLinkInvoke} from '../../device-link/invoke-context.js';
import {searchConversations} from '../conversationSearch.js';
import {registerSearchHandlers} from '@cindy/app-runtime/searchHandlers';
export function registerSearchIpc():void {registerSearchHandlers({ipcMain,isDeviceLinkInvoke,searchConversations});}
