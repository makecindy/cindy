package android.content

import java.io.File

class Context(val noBackupFilesDir: File) {
  companion object { const val MODE_PRIVATE = 0 }
  val applicationContext: Context get() = this
  val preferences = Preferences()
  fun getSharedPreferences(name: String, mode: Int) = preferences
}
class Preferences {
  val strings = mutableMapOf<String, String>()
  var writable = true
  fun edit() = Editor(this)
}
class Editor(private val preferences: Preferences) {
  private val mutations = mutableMapOf<String, String?>()
  fun remove(key: String): Editor { mutations[key] = null; return this }
  fun putString(key: String, value: String): Editor { mutations[key] = value; return this }
  fun commit(): Boolean {
    if (!preferences.writable) return false
    for ((key, value) in mutations) {
      if (value == null) preferences.strings.remove(key) else preferences.strings[key] = value
    }
    return true
  }
}
