/**
 * The controller re-reads the latest `local-db:messages:view` page of every session it still
 * shows after each new link (reconnect). A Host may therefore keep a session folded across a
 * link change: a session whose page this controller had read and not expanded on the previous
 * link gets no history details in the offline backlog, and only tool-start boundaries plus the
 * usual change notice until the new link's read completes
 * (docs/dev-rules/protocol-compatibility/device-link-history-relink-folded.md). A first read, an
 * expanded group and a page the Host cannot serve keep the existing full pushes. Undeclared
 * controllers keep the existing behavior; old Hosts ignore it.
 */
export const CONTROLLER_CAPABILITY_HISTORY_RELINK_FOLDED_V1 = 'history-relink-folded-v1';
