/**
 * endpoint-local-file.mjs — local 模式端点清单(config/endpoint.local.json)生成器。
 *
 * 背景:dev 默认读仓内 Global 正本 config/endpoint.global.json(远程生产/测试值);
 * 「连本地 server」的 local 模式改由本文件生成的 endpoint.local.json 承载——
 * auth / device-link / oss / model-access / voice / github / skillhub / plugin 指向 localhost
 * 八件套(oss / model-access / voice / github / skillhub / plugin 必须跟 auth 同侧:都用
 * AUTH_ISSUER 验签,本地 auth 签发的 token 过不了生产侧验签),
 * 其余字段(oauth broker / heartbeat / slack hook / website / 网关 / 更新链
 * CDN)照抄所选 region 正本(本地不起这些服务,沿用远程值,消费方各自的
 * "连不上就跳过"分支继续生效)。
 * 主进程经 XDT_ENDPOINT_MANIFEST_FILE 指到该文件(clientEndpointsService
 * 的 file 模式,allowHttp 放行 localhost http)。
 *
 * 文件 gitignored、**每次调用整文件重写**(幂等;手改会在下次 restart:local
 * 时丢失——需要长期自定义时改用 XDT_ENDPOINT_MANIFEST_FILE 指向自己的文件)。
 */
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_AUTH_BASE_URL = 'http://localhost:3344';
const LOCAL_DEVICE_LINK_BASE_URL = 'http://localhost:3335';
const LOCAL_OSS_BASE_URL = 'http://localhost:3340';
const LOCAL_MODEL_ACCESS_BASE_URL = 'http://localhost:3339';
const LOCAL_VOICE_BASE_URL = 'http://localhost:3342';
const LOCAL_GITHUB_BASE_URL = 'http://localhost:3336';
const LOCAL_SKILLHUB_BASE_URL = 'http://localhost:3341';
const LOCAL_PLUGIN_BASE_URL = 'http://localhost:3343';

/**
 * 从所选 region 正本生成 endpoint.local.json,返回生成文件的绝对路径。
 * 正本缺失/非法直接抛错(fail closed,不造半截配置)。
 * @param {{ repoRoot: string, region?: 'cn' | 'global' | 'dev' }} options
 */
export function generateEndpointLocalFile({ repoRoot, region = 'global' }) {
  const fileName = {
    cn: 'endpoint.json',
    global: 'endpoint.global.json',
    dev: 'endpoint.dev.json',
  }[region];
  if (!fileName) {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn, global or dev`);
  }
  const sourcePath = path.join(repoRoot, 'config', fileName);
  const targetPath = path.join(repoRoot, 'config', 'endpoint.local.json');
  const relativeSourcePath = `config/${fileName}`;
  let sourceText;
  try {
    sourceText = fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const devHint =
        region === 'dev'
          ? ' Copy config/endpoint.dev.json.example to config/endpoint.dev.json first.'
          : '';
      throw new Error(`Missing endpoint manifest ${relativeSourcePath}.${devHint}`);
    }
    throw new Error(`Failed to read endpoint manifest ${relativeSourcePath}: ${error.message}`);
  }

  let source;
  try {
    source = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`Invalid JSON in endpoint manifest ${relativeSourcePath}: ${error.message}`);
  }
  const local = {
    _note:
      '由 scripts/shared/endpoint-local-file.mjs 生成(restart:desktop:local / dev:desktop),' +
      `每次启动整文件重写,手改会丢;localhost 八件套之外的字段照抄 config/${fileName}。`,
    ...source,
    authApiBaseUrl: LOCAL_AUTH_BASE_URL,
    deviceLinkApiBaseUrl: LOCAL_DEVICE_LINK_BASE_URL,
    ossApiBaseUrl: LOCAL_OSS_BASE_URL,
    modelAccessApiBaseUrl: LOCAL_MODEL_ACCESS_BASE_URL,
    voiceApiBaseUrl: LOCAL_VOICE_BASE_URL,
    githubApiBaseUrl: LOCAL_GITHUB_BASE_URL,
    skillhubApiBaseUrl: LOCAL_SKILLHUB_BASE_URL,
    pluginApiBaseUrl: LOCAL_PLUGIN_BASE_URL,
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(local, null, 2)}\n`);
  return targetPath;
}
