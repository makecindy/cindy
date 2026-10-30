import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '@cindy/maker-core';

export interface EngineScanRequest {
  kind: 'scan';
  id: string;
  engine: AgentCustomization['engine'];
  options: ListCustomizationsOptions;
}

export interface CustomizationScanResponse {
  kind: 'result';
  id: string;
  result: ListCustomizationsResult | import('./scanner').ScanResult | import('./skillScanGrants').SkillScanGrants;
}

export type CustomizationScanRequest = EngineScanRequest
  | { kind: 'project'; id: string; input: import('./skillListProjection').SkillListProjectionInput }
  | { kind: 'grants'; id: string; input: import('./skillScanGrants').SkillScanGrantInput };
