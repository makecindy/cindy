import { ipcMain } from 'electron';
import { executeConversationSearch } from './search.js';

export function registerSearchIpc(): void {
  ipcMain.handle('local-db:conversations:search', (_event, payload: unknown) => executeConversationSearch(payload));
}
