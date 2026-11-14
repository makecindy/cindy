import type * as service from './service.js';

type EvaluationServices = Pick<typeof service, 'callEvaluate' | 'readEvaluationImageFile'>;
let services: EvaluationServices | null = null;

/** Bootstrap owns the heavy model/usage dependencies; plugin modules only call these ports. */
export function installEvaluationRuntime(value: EvaluationServices): void {
  services = value;
}

export const callEvaluate: EvaluationServices['callEvaluate'] = (...args) => {
  if (!services) return Promise.resolve({ ok: false, errorCode: 'UNAVAILABLE',
    message: '决策和重排模型服务尚未就绪', retryable: false, outcomeKnown: true });
  return services.callEvaluate(...args);
};

export const readEvaluationImageFile: EvaluationServices['readEvaluationImageFile'] = (...args) => {
  if (!services) return Promise.reject(new Error('Evaluation runtime is not initialized'));
  return services.readEvaluationImageFile(...args);
};
