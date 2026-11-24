/** Both native message IDs are needed: delayed answers can belong to an older question. */
export interface ExpectedDagTip {
  answerId: string;
  userMessageId: string;
}
export const DAG_TIP_REJECTED = 'DAG_TIP_REJECTED';
