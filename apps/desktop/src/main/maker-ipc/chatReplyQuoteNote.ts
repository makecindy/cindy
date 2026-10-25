import { createReplyQuoteReader } from '@cindy/app-runtime/chatReplyQuoteNote';
import { getDbClient } from '../localDb/client/current.js';
export { buildReplyQuoteNote, REPLY_QUOTE_SOURCE_CONTENT } from '@cindy/app-runtime/chatReplyQuoteNote';
export const { readReplyQuoteNote } = createReplyQuoteReader(getDbClient);
