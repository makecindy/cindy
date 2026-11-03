import { createContext, useContext } from 'react';

/** The slice of auth the question-card microphone needs. Kept out of AuthContext so card tests do not load the auth native graph. */
export type AskCardAuth = {
  getAccessToken(): Promise<string | null>;
  refreshAccessToken(): Promise<string | null>;
  apiFetch(path: string, opts: object): Promise<unknown>;
};

export const AskCardAuthContext = createContext<AskCardAuth | null>(null);

export function useAskCardAuth(): AskCardAuth | null {
  return useContext(AskCardAuthContext);
}
