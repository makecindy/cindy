import { createLogger } from '../logger';
import { createOrcaLeadReconcile } from '@cindy/runtime-db/orcaStrandedLeadReconcile';
export const { reconcileStrandedOrcaLeads } = createOrcaLeadReconcile(createLogger('orca-stranded-lead-reconcile'));
