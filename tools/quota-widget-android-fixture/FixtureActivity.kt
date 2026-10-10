package expo.modules.cindyquotawidget
import android.app.Activity
import android.app.Instrumentation
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONArray

object FixtureData {
 fun snapshot(state:String, now:Long=System.currentTimeMillis()):String {
  if(state=="clear")return QuotaSnapshot.empty().toString()
  val observed=now-if(state=="stale")3600000 else 0
  fun window(kind:String,minutes:Int,value:Int)=JSONObject().put("kind",kind).put("minutes",minutes).put("remainingPercent",if(state=="unknown")JSONObject.NULL else if(state=="zero")0 else value).put("observedAtMs",observed).put("resetAtMs",now+if(minutes==10080)6*86400000L+23*3600000+59*60000 else 4*3600000L+59*60000+59000)
  fun row(platform:String)=JSONObject().put("platform",platform).put("available",state!="unauthorized").put("status",if(state=="unauthorized")"unauthorized" else "ready").put("observedAtMs",observed).put("plan",if(state=="missing-plan")JSONObject.NULL else if(platform=="claude")"Max" else "Pro").put("extraResetsRemaining",if(state=="unknown")JSONObject.NULL else if(state=="zero")0 else 3)
  val claude=row("claude").put("windows",JSONArray().put(window("sevenDay",10080,100)).put(window("fiveHour",300,100)).put(window("scoped",10080,100).put("scope","Fable")))
  val codex=row("codex").put("windows",JSONArray().put(window("primary",10080,100)))
  if(state=="missing-window")claude.put("windows",JSONArray().put(window("sevenDay",10080,77)))
  if(state=="partial"){
   claude.getJSONArray("windows").getJSONObject(0).put("remainingPercent",78)
   codex.getJSONArray("windows").getJSONObject(0).put("remainingPercent",27)
  }
  if(state=="long-plan"){codex.put("platform","xai").put("plan","SuperGrok Heavy");claude.put("plan","Enterprise")}
  val rows=JSONArray().put(claude).put(codex)
  if(state=="three-providers") rows.put(row("xai").put("plan","SuperGrok").put("windows",JSONArray().put(window("week",10080,63))))
  return JSONObject().put("version",2).put("source","demo").put("connection",if(state=="offline")"offline" else "online").put("rows",rows).toString()
 }
}
class FixtureActivity:Activity(){
 override fun onCreate(b:Bundle?){super.onCreate(b)
  val state=intent.getStringExtra("state")?:"partial"
  if(state=="inspect") {
   val manager=AppWidgetManager.getInstance(this)
   val component=ComponentName(this,QuotaWidgetProvider::class.java)
   val lines=manager.getAppWidgetIds(component).map { id ->
    val info=manager.getAppWidgetInfo(id)
    val options=manager.getAppWidgetOptions(id)
    "id=$id target=${info.targetCellWidth}x${info.targetCellHeight} " + options.keySet().sorted().joinToString { key -> "$key=${options.get(key)}" }
   }
   setContentView(TextView(this).apply { text=lines.joinToString("\n");textSize=14f;setPadding(16,60,16,16) })
   return
  }
  if(intent.data==null){if(state=="clear")QuotaSnapshot.clear(this) else QuotaSnapshot.save(this,FixtureData.snapshot(state));QuotaWidgetProvider.updateAll(this)}
  val box=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(28,70,28,28)}
  box.addView(TextView(this).apply{text="DEMO DATA — isolated widget harness\nActual production AppWidget / snapshot code\nState: $state\n"+(if(intent.data!=null)"PASS: widget deep link" else "No login or real account data");textSize=20f})
  box.addView(Button(this).apply{text="Add test widget";setOnClickListener{AppWidgetManager.getInstance(this@FixtureActivity).requestPinAppWidget(ComponentName(this@FixtureActivity,QuotaWidgetProvider::class.java),null,null)}})
  setContentView(box)
 }
}
class ContractInstrumentation:Instrumentation(){
 override fun onCreate(arguments:Bundle?){super.onCreate(arguments);start()}
 override fun onStart(){
  var checks=0
  fun verify(v:Boolean){check(v);checks++}
  val now=1800000000000L
  try {
   for(icon in listOf(R.drawable.cindy_quota_claude,R.drawable.cindy_quota_codex,R.drawable.cindy_quota_xai))verify(targetContext.getDrawable(icon)!=null)
   verify(QuotaWidgetPresentation.layout(356,164,1f,3).count==2)
   verify(!QuotaWidgetPresentation.layout(356,164,1f,3).showMoreHint)
   verify(QuotaWidgetPresentation.layout(178,164,1f,3).count==1)
   verify(QuotaWidgetPresentation.layout(356,184,1f,3).showMoreHint)
   verify(QuotaWidgetPresentation.layout(356,328,1f,3).count==3)
   val base=JSONObject(FixtureData.snapshot("long",now))
   for(raw in listOf<Any>(JSONObject.NULL,0,3,99,-1,1.5,9_007_199_254_740_992.0)){
    base.getJSONArray("rows").getJSONObject(1).put("extraResetsRemaining",raw)
    val row=QuotaSnapshot.sanitize(base.toString()).getJSONArray("rows").getJSONObject(1)
    val expected=when(raw){0->"0";3->"3";99->"99";else->"—"}
    verify(QuotaWidgetPresentation.extra(row,"online",now)==expected)
    verify(QuotaWidgetPresentation.extra(row,"offline",now)=="—")
    verify(QuotaWidgetPresentation.extra(row,"online",now+900000)=="—")
   }
   base.getJSONArray("rows").getJSONObject(1).remove("extraResetsRemaining")
   verify(QuotaWidgetPresentation.extra(QuotaSnapshot.sanitize(base.toString()).getJSONArray("rows").getJSONObject(1),"online",now)=="—")
   verify(QuotaWidgetPresentation.duration(now+6*86400000L+23*3600000,now)=="6d 23h")
   verify(QuotaWidgetPresentation.duration(now+4*3600000L+59*60000,now)=="4h 59m")
   for(state in listOf("long","zero","unknown","stale","offline","unauthorized","missing-plan","missing-window")){
    val s=QuotaSnapshot.sanitize(FixtureData.snapshot(state,now));val r=s.getJSONArray("rows").getJSONObject(0);val w=r.getJSONArray("windows").getJSONObject(0)
    verify(QuotaWidgetPresentation.value(r,w,s.getString("connection"),now)==when(state){"zero"->"0%";"unknown","stale","offline","unauthorized"->"—";"missing-window"->"77%";else->"100%"})
   }
   val bad=JSONObject(FixtureData.snapshot("long",now));bad.getJSONArray("rows").getJSONObject(0).getJSONArray("windows").getJSONObject(2).remove("scope")
   var rejected=false;try{QuotaSnapshot.sanitize(bad.toString())}catch(e:IllegalArgumentException){rejected=true};verify(rejected)
   QuotaSnapshot.save(targetContext,FixtureData.snapshot("long",now));verify(QuotaSnapshot.load(targetContext).getJSONArray("rows").length()==2)
   QuotaSnapshot.clear(targetContext);verify(QuotaSnapshot.load(targetContext).getJSONArray("rows").length()==0)
   finish(Activity.RESULT_OK,Bundle().apply{putString("stream","PASS: $checks real Android contract checks\n")})
  }catch(t:Throwable){finish(Activity.RESULT_CANCELED,Bundle().apply{putString("stream","FAIL after $checks: $t")})}
 }
}
