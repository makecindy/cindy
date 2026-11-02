package app.cindy.usagewidgets

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Writes the widget store into the app's files directory, where the providers read it, then
 * redraws the widgets. The JS side is the same as the iOS module's.
 */
class CindyUsageWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CindyUsageWidgets")

    /** Returns false when the file could not be written. */
    Function("writeSnapshot") { json: String ->
      val context = appContext.reactContext ?: return@Function false
      try {
        val file = WidgetStore.file(context)
        val temporary = File(file.parentFile, file.name + ".tmp")
        temporary.writeText(json)
        if (!temporary.renameTo(file)) {
          file.delete()
          if (!temporary.renameTo(file)) return@Function false
        }
      } catch (_: Exception) {
        return@Function false
      }
      UsageWidgetProviderBase.updateAllAsync(context)
      true
    }

    Function("readSnapshot") {
      val context = appContext.reactContext ?: return@Function null
      val file = WidgetStore.file(context)
      if (file.exists()) file.readText() else null
    }

    /** Computers some widget is set to, so the app asks them as well as the automatic one. */
    Function("readPinnedDeviceIds") {
      val context = appContext.reactContext ?: return@Function emptyList<String>()
      WidgetStore.pinnedDeviceIds(context)
    }

    Function("clearSnapshot") {
      val context = appContext.reactContext ?: return@Function null
      WidgetStore.file(context).delete()
      WidgetStore.clearAccountPreferences(context)
      UsageWidgetProviderBase.updateAllAsync(context)
      null
    }
  }
}
