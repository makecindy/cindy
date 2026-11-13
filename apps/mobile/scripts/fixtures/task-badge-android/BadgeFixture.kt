package app.cindy.notifications
import android.content.Context
import me.leolin.shortcutbadger.ShortcutBadger
import org.json.JSONObject

private fun summary(version: String, count: Int, complete: Boolean = true, account: String = "owner") = JSONObject()
  .put("schemaVersion", 1).put("accountId", account).put("version", version).put("complete", complete)
  .put("badgeCount", count).put("waitingCount", count).put("unreadCount", 0).put("runningCount", 3)

fun main() {
  val context = Context()
  TaskBadgeDelivery.identity(context, "global:owner", "owner")
  check(TaskBadgeDelivery.apply(context, summary("9007199254740993", 6)))
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740992", 0)))
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740994", 0, account = "other")))
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740994", 0, complete = false)))
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740993", 0)))
  check(ShortcutBadger.writes == listOf(6))
  check(TaskBadgeDelivery.currentCount(context) == 6)
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740995", 0).put("badgeCount", 0.1)))
  check(TaskBadgeDelivery.apply(context, summary("9007199254740995", 0)))
  check(ShortcutBadger.writes == listOf(6, 0))
  TaskBadgeDelivery.identity(context, "global:other", "other")
  check(!TaskBadgeDelivery.apply(context, summary("9007199254740996", 8)))
  check(TaskBadgeDelivery.apply(context, summary("1", 2, account = "other")))
  TaskBadgeDelivery.identity(context, "", "")
  check(!TaskBadgeDelivery.apply(context, summary("2", 5, account = "other")))
  check(ShortcutBadger.writes.last() == 0)
  println("TaskBadgeDelivery: native version/account/incomplete/zero/sign-out checks passed")
}
