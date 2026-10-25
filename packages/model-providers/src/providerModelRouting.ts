import type { Provider, AgentKind, RoutingDescriptor } from './types.js';
import { resolvePiModelRoute } from './pi-catalog-marker.js';

export function providerRoutingForModel(
  provider: Provider,
  agent: AgentKind,
  wireModel: string | undefined,
): RoutingDescriptor | null {
  const routing = provider.routing[agent];
  if (!routing) return null;
  const model = wireModel
    ? provider.models[agent]?.find((candidate) => candidate.id === wireModel)
    : undefined;
  const modelRoute = model?.route;
  const piRoute =
    agent === 'pi'
      ? resolvePiModelRoute(model, {
          baseUrl: routing.upstream,
          wireProtocol: routing.wireProtocol,
        })
      : undefined;
  if (agent === 'pi' && piRoute === null) return null;
  if (
    !modelRoute &&
    (agent !== 'pi' ||
      (piRoute?.baseUrl === routing.upstream && piRoute.wireProtocol === routing.wireProtocol))
  )
    return routing;

  // 鉴权、固定 headers 与模型 namespace 门继续继承 provider/runtime；请求路径不能在
  // 协议切换后误继承旧 runtime 的路径，只有模型覆盖显式声明时才带回。
  const inherited = { ...routing };
  delete inherited.requestPath;
  return {
    ...inherited,
    upstream: agent === 'pi' ? piRoute!.baseUrl : modelRoute!.baseUrl,
    wireProtocol: agent === 'pi' ? piRoute!.wireProtocol : modelRoute!.wireProtocol,
    ...(agent === 'pi'
      ? piRoute!.requestPath
        ? { requestPath: piRoute!.requestPath }
        : {}
      : modelRoute?.requestPath
        ? { requestPath: modelRoute.requestPath }
        : {}),
  };
}

