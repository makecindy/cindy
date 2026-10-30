const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
} = require('@expo/config-plugins');

const PACKAGE_NAME = 'xdt-wechat-login';

function withWechatLogin(config, options = {}) {
  const appId = String(options.appId || '').trim();
  const universalLink = String(options.universalLink || '').trim();
  if (!appId) throw new Error('xdt-wechat-login requires appId');
  if (!universalLink)
    throw new Error('xdt-wechat-login requires universalLink');
  const parsedUniversalLink = new URL(universalLink);
  if (
    parsedUniversalLink.protocol !== 'https:' ||
    !parsedUniversalLink.hostname
  ) {
    throw new Error('xdt-wechat-login universalLink must be an https URL');
  }
  config = withWechatInfoPlist(config, appId);
  config = withWechatEntitlements(config, parsedUniversalLink.hostname);
  config = withWechatAndroidManifest(config);
  config = withWechatEntryActivity(config, appId);
  return config;
}

function withWechatInfoPlist(config, appId) {
  return withInfoPlist(config, (config) => {
    const info = config.modResults;
    info.LSApplicationQueriesSchemes = unique([
      ...(info.LSApplicationQueriesSchemes || []),
      'weixin',
      'weixinULAPI',
      'weixinURLParamsAPI',
    ]);
    const urlTypes = Array.isArray(info.CFBundleURLTypes)
      ? info.CFBundleURLTypes
      : [];
    if (!urlTypes.some((entry) => entry.CFBundleURLSchemes?.includes(appId))) {
      urlTypes.push({ CFBundleURLName: appId, CFBundleURLSchemes: [appId] });
    }
    info.CFBundleURLTypes = urlTypes;
    return config;
  });
}

function withWechatEntitlements(config, universalLinkHost) {
  return withEntitlementsPlist(config, (config) => {
    const key = 'com.apple.developer.associated-domains';
    config.modResults[key] = unique([
      ...(config.modResults[key] || []),
      `applinks:${universalLinkHost}`,
    ]);
    return config;
  });
}

function withWechatAndroidManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      config.modResults,
    );
    application.activity = application.activity || [];
    if (
      !application.activity.some(
        (entry) => entry.$?.['android:name'] === '.wxapi.WXEntryActivity',
      )
    ) {
      application.activity.push({
        $: {
          'android:name': '.wxapi.WXEntryActivity',
          'android:exported': 'true',
          'android:launchMode': 'singleTask',
        },
      });
    }
    manifest.queries = manifest.queries || [];
    if (
      !manifest.queries.some((query) =>
        query.package?.some(
          (item) => item.$?.['android:name'] === 'com.tencent.mm',
        ),
      )
    ) {
      manifest.queries.push({
        package: [{ $: { 'android:name': 'com.tencent.mm' } }],
      });
    }
    return config;
  });
}

function withWechatEntryActivity(config, appId) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const applicationId = config.android?.package;
      if (!applicationId)
        throw new Error('xdt-wechat-login requires android.package');
      const sourceDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java',
        ...applicationId.split('.'),
        'wxapi',
      );
      fs.mkdirSync(sourceDir, { recursive: true });
      const kotlinAppId = JSON.stringify(appId);
      fs.writeFileSync(
        path.join(sourceDir, 'WXEntryActivity.kt'),
        `package ${applicationId}.wxapi

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler
import com.tencent.mm.opensdk.modelbase.BaseReq
import com.tencent.mm.opensdk.modelbase.BaseResp
import com.tencent.mm.opensdk.openapi.WXAPIFactory
import com.xdtmaker.wechatlogin.XdtWechatAuthCoordinator

class WXEntryActivity : Activity(), IWXAPIEventHandler {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WXAPIFactory.createWXAPI(this, ${kotlinAppId}, false).handleIntent(intent, this)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    WXAPIFactory.createWXAPI(this, ${kotlinAppId}, false).handleIntent(intent, this)
  }

  override fun onReq(request: BaseReq) { finish() }

  override fun onResp(response: BaseResp) {
    XdtWechatAuthCoordinator.handleResponse(response)
    finish()
  }
}
`,
      );
      return config;
    },
  ]);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = createRunOncePlugin(withWechatLogin, PACKAGE_NAME, '0.1.0');
