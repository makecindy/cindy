export const ORCA_NESTED_REPORT_ERROR_CODE = 'NESTED_AGENT_NOT_ALLOWED' as const;
export const ORCA_NESTED_REPORT_ERROR_MESSAGE =
  'nested agent cannot report directly to the lead' as const;
export const ORCA_NESTED_REPORT_DENIAL_REASON =
  `${ORCA_NESTED_REPORT_ERROR_CODE}: ${ORCA_NESTED_REPORT_ERROR_MESSAGE}` as const;
