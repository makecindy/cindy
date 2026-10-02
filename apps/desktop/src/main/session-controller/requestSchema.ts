import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { sessionControlRequestSchema } from '@cindy/maker-shared/session-controller-schema';
import { SessionAdmissionError } from './controller.js';

export function parseSessionControlRequest(value: unknown): SessionControlRequest {
  const result = sessionControlRequestSchema.safeParse(value);
  if (!result.success) throw new SessionAdmissionError('INVALID_ARGS', 'Session 控制请求格式不正确。');
  const request = result.data;
  const deviceOnly = request.command.operation === 'listActive' || request.command.operation === 'listRecords' || request.command.operation === 'createRecord';
  if (deviceOnly ? request.target !== undefined : !request.target || request.target.deviceId !== request.deviceId) {
    throw new SessionAdmissionError('INVALID_ARGS', 'Session 目标与设备不一致。');
  }
  return request;
}
