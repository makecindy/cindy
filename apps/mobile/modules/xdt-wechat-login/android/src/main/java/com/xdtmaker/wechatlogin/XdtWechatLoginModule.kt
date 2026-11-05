package com.xdtmaker.wechatlogin

import com.tencent.mm.opensdk.modelbase.BaseResp
import com.tencent.mm.opensdk.modelbase.BaseReq
import com.tencent.mm.opensdk.modelmsg.SendAuth
import com.tencent.mm.opensdk.modelmsg.ShowMessageFromWX
import com.tencent.mm.opensdk.openapi.IWXAPI
import com.tencent.mm.opensdk.openapi.WXAPIFactory
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Process-wide pending request resolved by the generated WXEntryActivity. */
object XdtWechatAuthCoordinator {
  private var pendingPromise: Promise? = null
  private var expectedState: String? = null
  private val launchInfos = mutableListOf<String>()
  @Volatile var onLaunch: (() -> Unit)? = null

  @Synchronized
  fun consumeLaunchInfos(): List<String> {
    val pending = launchInfos.toList()
    launchInfos.clear()
    return pending
  }

  @Synchronized
  fun handleRequest(request: BaseReq): Boolean {
    val info = (request as? ShowMessageFromWX.Req)?.message?.messageExt ?: return false
    if (!Regex("[A-Za-z0-9_-]{32}").matches(info)) return false
    if (!launchInfos.contains(info) && launchInfos.size < 2) launchInfos.add(info)
    onLaunch?.invoke()
    return true
  }

  fun begin(promise: Promise, state: String): Boolean {
    if (pendingPromise != null) return false
    pendingPromise = promise
    expectedState = state
    return true
  }

  fun reject(code: String, message: String) {
    val current = pendingPromise
    pendingPromise = null
    expectedState = null
    current?.reject(code, message, null)
  }

  fun cancel() {
    reject("ERR_WECHAT_CANCELLED_BY_CLIENT", "WeChat authorization was cancelled by Cindy.")
  }

  fun handleResponse(response: BaseResp) {
    val auth = response as? SendAuth.Resp ?: return
    if (auth.state != expectedState) {
      reject("ERR_WECHAT_STATE_MISMATCH", "WeChat state verification failed.")
      return
    }
    if (auth.errCode != BaseResp.ErrCode.ERR_OK || auth.code.isNullOrBlank()) {
      val code = if (auth.errCode == BaseResp.ErrCode.ERR_USER_CANCEL) {
        "ERR_WECHAT_CANCELLED"
      } else {
        "ERR_WECHAT_LOGIN_FAILED"
      }
      reject(code, "WeChat authorization did not complete.")
      return
    }
    val current = pendingPromise
    pendingPromise = null
    expectedState = null
    current?.resolve(mapOf("code" to auth.code))
  }
}

/** Minimal Expo wrapper around the official WeChat OpenSDK authorization request. */
class XdtWechatLoginModule : Module() {
  private var api: IWXAPI? = null

  override fun definition() = ModuleDefinition {
    Name("XdtWechatLogin")
    Events("onWechatLaunch")

    OnCreate {
      XdtWechatAuthCoordinator.onLaunch = { sendEvent("onWechatLaunch", emptyMap<String, Any>()) }
    }
    OnDestroy { XdtWechatAuthCoordinator.onLaunch = null }

    AsyncFunction("consumeWechatLaunchInfos") {
      XdtWechatAuthCoordinator.consumeLaunchInfos()
    }

    AsyncFunction("isWechatInstalled") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      api?.isWXAppInstalled
        ?: (context.packageManager.getLaunchIntentForPackage("com.tencent.mm") != null)
    }

    AsyncFunction("requestWechatAuthCode") { options: Map<String, Any?>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_WECHAT_NO_CONTEXT", "No Android application context.", null)
        return@AsyncFunction
      }
      val appId = options["appId"] as? String
      val state = options["state"] as? String
      if (appId.isNullOrBlank()) {
        promise.reject("ERR_WECHAT_INVALID_APP_ID", "Missing WeChat appId.", null)
        return@AsyncFunction
      }
      if (state.isNullOrBlank()) {
        promise.reject("ERR_WECHAT_INVALID_STATE", "Missing WeChat request state.", null)
        return@AsyncFunction
      }
      if (!XdtWechatAuthCoordinator.begin(promise, state)) {
        promise.reject("ERR_WECHAT_IN_PROGRESS", "WeChat login is already in progress.", null)
        return@AsyncFunction
      }
      val wxApi = WXAPIFactory.createWXAPI(context, appId, true)
      api = wxApi
      if (!wxApi.registerApp(appId)) {
        XdtWechatAuthCoordinator.reject("ERR_WECHAT_REGISTER_FAILED", "Could not register the WeChat application.")
        return@AsyncFunction
      }
      val request = SendAuth.Req().apply {
        scope = (options["scope"] as? String) ?: "snsapi_userinfo"
        this.state = state
      }
      if (!wxApi.sendReq(request)) {
        XdtWechatAuthCoordinator.reject("ERR_WECHAT_LAUNCH_FAILED", "Could not open WeChat.")
      }
    }

    AsyncFunction("cancelWechatAuthRequest") {
      XdtWechatAuthCoordinator.cancel()
    }
  }
}
