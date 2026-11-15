/**
 * Claude Code SDK structured `/context` payload.
 *
 * Mirrors `SDKControlGetContextUsageResponse` without importing SDK types into
 * desktop renderer contracts. Keep this JSON-serializable: it crosses IPC.
 */
export interface ContextUsageData {
  textEstimate?: import('@cindy/maker-shared/session-controls').ContextTextEstimate;
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: Array<Array<{
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }>>;
  model: string;
  memoryFiles: Array<{
    path: string;
    type: string;
    tokens: number;
  }>;
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  deferredBuiltinTools?: Array<{
    name: string;
    tokens: number;
    isLoaded: boolean;
  }>;
  systemTools?: Array<{
    name: string;
    tokens: number;
  }>;
  systemPromptSections?: Array<{
    name: string;
    tokens: number;
  }>;
  agents: Array<{
    agentType: string;
    source: string;
    tokens: number;
  }>;
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{
      name: string;
      source: string;
      tokens: number;
    }>;
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens?: number;
    unattributedTokens?: number;
    toolCallsByType: Array<{
      name: string;
      callTokens: number;
      resultTokens: number;
    }>;
    attachmentsByType: Array<{
      name: string;
      tokens: number;
    }>;
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}
