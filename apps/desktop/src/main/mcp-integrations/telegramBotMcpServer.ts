import { createTelegramBotMcpServer as createShared, type TelegramBotMcpDeps } from '@cindy/im-runtime/telegramBotMcpServer';
import { createLogger } from '../logger.js';
export type { TelegramBotMcpDeps } from '@cindy/im-runtime/telegramBotMcpServer';
export function createTelegramBotMcpServer(deps: TelegramBotMcpDeps) { return createShared(deps, createLogger('mcp/cindy_telegram_bot')); }
export { TELEGRAM_DOWNLOAD_SUBDIR } from '@cindy/im-runtime/telegramBotMcpServer';
