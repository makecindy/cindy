package expo.modules.updates

import android.content.Context
import org.json.JSONObject
import java.net.URI

class UpdatesConfiguration {
  companion object {
    var fixtureRuntime = "r1"
    fun create(context: Context, config: UpdatesConfiguration, configOverride: UpdatesConfigurationOverride?): UpdatesConfiguration =
      UpdatesConfiguration(context, null, false, configOverride)
  }
  val updateUrl = URI("https://updates.example.invalid/manifest")
  val scopeKey = "https://updates.example.invalid"
  val originalEmbeddedRequestHeaders = mapOf("EAS-Client-ID" to "00000000-0000-4000-8000-000000000000", "x-cindy-update-channel" to "")
  val disableAntiBrickingMeasures = false
  private val nativeRuntime = fixtureRuntime
  val requestHeaders: Map<String, String>
  constructor(context: Context, overrideMap: Map<String, Any>?, disableAntiBrickingMeasures: Boolean, configOverride: UpdatesConfigurationOverride?) {
    requestHeaders = configOverride?.requestHeaders ?: originalEmbeddedRequestHeaders
  }
  fun getRuntimeVersion() = nativeRuntime
}
data class UpdatesConfigurationOverride(val updateUrl: URI?, val requestHeaders: Map<String, String>?)
class FixtureController {
  lateinit var context: Context
  var lastHeaders: Map<String, String>? = null
  fun setUpdateRequestHeadersOverride(headers: Map<String, String>?) {
    lastHeaders = headers
    context.preferences.strings["updatesConfigOverride"] = JSONObject().put("requestHeaders", JSONObject(headers)).toString()
  }
}
object UpdatesController { val instance = FixtureController() }
