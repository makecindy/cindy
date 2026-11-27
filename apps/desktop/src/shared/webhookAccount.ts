/** 同账号地址管理的安全投影，不含签名密钥、请求正文或任务提示词。 */
export interface WebhookAccountEndpoint {
  id: string;
  url: string;
  scheduleId: string;
  scheduleName: string | null;
  deviceId: string;
  deviceName: string | null;
  currentDevice: boolean;
  status: 'active' | 'suspended';
  lastReceivedAt: string | null;
}

export interface WebhookAccountOverview {
  used: number;
  limit: number;
  endpoints: WebhookAccountEndpoint[];
}
