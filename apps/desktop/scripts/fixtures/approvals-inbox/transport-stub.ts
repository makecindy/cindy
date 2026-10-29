/** Session and Orca lookups for the approvals-inbox fixture (synthetic data). */
import { ALL, LEADS } from './data';

const worker = (sessionId: string) => ALL.find((item) => item.sessionId === sessionId);

export const getSessionFor = async (sessionId: string) => {
  const request = worker(sessionId);
  if (request) {
    return { id: sessionId, title: request.title, orcaRole: 'worker', workingDir: '/projects/' + request.project, source: 'manual' };
  }
  return { id: sessionId, title: LEADS[sessionId] ?? sessionId, orcaRole: 'lead', workingDir: '/projects/cindy-desktop', source: 'manual' };
};

export const orcaWorkflowsFor = () => ({
  getByWorkerSession: async (sessionId: string) => {
    const request = worker(sessionId);
    return request ? { id: 'team-' + request.lead, leadSessionId: request.lead } : null;
  },
  listWorkersByLead: async (leadSessionId: string) => ALL
    .filter((item) => item.lead === leadSessionId)
    .map((item) => ({ sessionId: item.sessionId, role: item.role, label: item.label })),
});
