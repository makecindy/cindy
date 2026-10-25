import {createConversationSearch} from '@cindy/app-runtime/conversationSearch';
import {getDbClient} from './client/current.js';
import {searchChatHistoryHybrid} from './chatHistorySearch.js';
export type {ConversationSearchHostScope} from '@cindy/app-runtime/conversationSearch';
export const {searchConversations}=createConversationSearch({getDbClient,searchChatHistoryHybrid});
