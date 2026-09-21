package expo.modules.cindyappinstaller

import android.Manifest
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class UpdateFileProvider : FileProvider()

class CindyAppInstallerModule : Module() {
  private var permissionPromise: Promise? = null
  private val permissionRequestCode = 48173

  override fun definition() = ModuleDefinition {
    Name("CindyAppInstaller")

    // Check the installed manifest, never a mutable OTA extra or JS flag.
    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && declaresInstallPermission()
    }
    AsyncFunction("hasPermission") { declaresInstallPermission() && canInstall() }
    AsyncFunction("requestPermission") { promise: Promise ->
      when {
        !declaresInstallPermission() -> promise.resolve(false)
        canInstall() -> promise.resolve(true)
        permissionPromise != null -> promise.reject("ERR_INSTALL_BUSY", "Permission request already open", null)
        else -> {
          try {
            val activity = requireNotNull(appContext.currentActivity)
            permissionPromise = promise
            activity.startActivityForResult(
              Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
              permissionRequestCode,
            )
          } catch (error: Exception) {
            permissionPromise = null
            promise.reject("ERR_INSTALL_PERMISSION", "Unable to open install settings", error)
          }
        }
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, result ->
      if (result.requestCode == permissionRequestCode) {
        val pending = permissionPromise
        permissionPromise = null
        // RESULT_OK is not reliable for settings activities; read the actual permission.
        pending?.resolve(canInstall())
      }
    }
    OnDestroy {
      permissionPromise?.reject("ERR_INSTALL_CLOSED", "Installer was closed", null)
      permissionPromise = null
    }

    AsyncFunction("install") { fileUri: String, expectedVersion: String ->
      val context = requireNotNull(appContext.reactContext)
      require(declaresInstallPermission() && canInstall()) { "Install permission not granted" }
      val uri = Uri.parse(fileUri)
      require(uri.scheme == "file") { "Expected a local APK" }
      val file = File(requireNotNull(uri.path)).canonicalFile
      val directory = File(context.cacheDir, "cindy-updates").canonicalFile
      require(file.parentFile == directory && file.extension == "apk" && file.isFile) { "Invalid update path" }
      val pm = context.packageManager
      @Suppress("DEPRECATION")
      val archive = requireNotNull(pm.getPackageArchiveInfo(file.path, 0)) { "Invalid APK" }
      require(archive.packageName == context.packageName) { "APK belongs to another app" }
      require(archive.versionName == expectedVersion) { "APK does not match the selected update" }
      @Suppress("DEPRECATION")
      val installed = pm.getPackageInfo(context.packageName, 0)
      val newer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        archive.longVersionCode > installed.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        (archive.versionCode > installed.versionCode)
      }
      require(newer) { "APK is not a newer build" }
      // Android's package installer verifies the APK signature against the installed app,
      // including signing-key rotation. It owns the final user confirmation and replacement.
      val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.cindy.updates", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        clipData = ClipData.newRawUri("update", contentUri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      // Do not delete the file here: the system installer still needs to read it.
    }
  }

  private fun canInstall(): Boolean {
    val context = appContext.reactContext ?: return false
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
  }

  @Suppress("DEPRECATION")
  private fun declaresInstallPermission(): Boolean {
    val context = appContext.reactContext ?: return false
    return context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
      .requestedPermissions?.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES) == true
  }
}
