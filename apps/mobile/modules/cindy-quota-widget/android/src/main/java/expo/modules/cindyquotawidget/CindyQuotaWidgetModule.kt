package expo.modules.cindyquotawidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CindyQuotaWidgetModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  override fun definition() = ModuleDefinition {
    Name("CindyQuotaWidget")
    Function("writeSnapshot") { json: String ->
      QuotaSnapshot.save(context, json)
      QuotaWidgetProvider.updateAll(context)
    }
    Function("clearSnapshot") {
      QuotaSnapshot.clear(context)
      QuotaWidgetProvider.updateAll(context)
    }
    Function("setPresentation") { locale: String, appearance: String ->
      require(locale in listOf("en", "zh-CN", "zh-TW", "ja", "ko") && appearance in listOf("system", "light", "dark"))
      val prefs = context.getSharedPreferences("cindy-quota-presentation", 0)
      if (prefs.getString("locale", "") != locale || prefs.getString("appearance", "") != appearance) {
        check(prefs.edit().putString("locale", locale).putString("appearance", appearance).commit())
        QuotaWidgetProvider.updateAll(context)
      }
    }
  }
}
