import { createRightSidebarTabsService } from '../../../desktop/src/main/localDb/ipc/rightSidebarTabs.ts';
/** Synthetic account and empty optional features; real SQLite/profile readers.
 * Only the test server imports this file, never the production Host. */
import {
  readHostSessionList,
  readHostSession,
} from "../../src/session-reads.ts";
import {
  createHostHistoryReader,
  readMessagesList,
} from "../../src/agent/history.ts";
import { readProfileSettings } from "../../src/profile-settings.mjs";
export function desktopPorts({
  profile,
  ownerId,
  db,
  graph,
  config,
  modelAccess,
  input,
}) {
  const auth = () => ({
    user: {
      id: ownerId,
      email: "fixture@example.invalid",
      name: "Handoff fixture",
    },
    mode: "cloud",
    dataOwnerId: ownerId,
    ownerGeneration: 1,
    canEnterApp: true,
    isAuthenticated: true,
    isCanary: false,
    deviceId: "isolated-handoff",
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
    credentialStoreUnavailable: false,
  });
  const history = createHostHistoryReader();
  return {
    rightSidebarTabs: createRightSidebarTabsService({ getDb: () => db().drizzle, changed: () => {} }),
    getAuthState: auth,
    refreshAuth: auth,
    me: auth,
    listSessions: (body) => readHostSessionList(db().drizzle, body),
    getSession: (id) => readHostSession(db().drizzle, id),
    history: (id, limit) => readMessagesList(id, { limit }),
    messagesList: (id, limit, before) =>
      readMessagesList(id, { limit, before }),
    historyView: (id, before) => history.page(id, before ?? undefined, true),
    workDetails: (id, ref, after) => history.details(id, ref, after),
    profile: () => readProfileSettings({ dataDir: profile, ownerId }),
    listProjectAliases: () => [],
    listRecentWorkdirs: () => [],
    interruptedPending: () => [],
    errorTailPending: () => [],
    interruptedCandidates: () => [],
    turnChangeSets: () => [],
    ghosts: () => [],
    pluginRuntimeStates: () => ({}),
    listPluginCards: () => [],
    agents: () => graph().agents,
    providers: () => config().publicViews(true),
    modelAccess: () => modelAccess().sync.getStatus(),
    agentAuthState: () => ({ authenticated: true, authSource: "api-key" }),
    agentStatus: () => ({ available: true }),
    capabilities: (agentKind) => ({
      capabilities: graph().capabilitiesByAgent[agentKind],
    }),
    modelVisibilityClaim: () => ({
      dataOwnerId: ownerId,
      ownerGeneration: 1,
      canWriteOwnerScoped: true,
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: false,
      profileOrigin: "existing",
    }),
    estimatedSessionValue: () => ({ totalValueUsd: 0, entries: [] }),
    input,
  };
}
