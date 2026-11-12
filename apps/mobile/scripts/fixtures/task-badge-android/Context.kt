package android.content

class Context {
  companion object { const val MODE_PRIVATE = 0 }
  private val stores = mutableMapOf<String, Preferences>()
  fun getSharedPreferences(name: String, mode: Int) = stores.getOrPut(name) { Preferences() }
}
class Preferences {
  val data = mutableMapOf<String, Any>()
  fun getString(key: String, default: String) = data[key] as? String ?: default
  fun getInt(key: String, default: Int) = data[key] as? Int ?: default
  fun getBoolean(key: String, default: Boolean) = data[key] as? Boolean ?: default
  fun contains(key: String) = data.containsKey(key)
  fun edit() = Editor(this)
}
class Editor(private val preferences: Preferences) {
  fun clear(): Editor { preferences.data.clear(); return this }
  fun putString(key: String, value: String): Editor { preferences.data[key] = value; return this }
  fun putInt(key: String, value: Int): Editor { preferences.data[key] = value; return this }
  fun putBoolean(key: String, value: Boolean): Editor { preferences.data[key] = value; return this }
  fun apply() {}
}
