import type { ModelAccessCredentialSource } from '../modelAccess.js';

export interface ModelAccessCredentialsStore {
  getSource(): ModelAccessCredentialSource | null;
  /** source='server' 时返回下发的 endpoint;否则 null。 */
  getServerEndpoint(): string | null;
  /** 服务端下发成功后记录(覆盖旧标记)。 */
  setServerCredentials(endpoint: string): void;
  /** 用户手填保存成功后记录(manual 无配套 endpoint,effectiveEndpoint 视为网关不可用)。 */
  setManualSource(): void;
  /** 清除标记(手填 key 被删除等)。 */
  clear(): void;
}
