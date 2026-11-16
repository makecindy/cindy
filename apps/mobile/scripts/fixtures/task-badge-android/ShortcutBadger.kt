package me.leolin.shortcutbadger
import android.content.Context

object ShortcutBadger {
  val writes = mutableListOf<Int>()
  fun applyCount(context: Context, count: Int): Boolean { writes.add(count); return true }
  fun removeCount(context: Context) = applyCount(context, 0)
}
