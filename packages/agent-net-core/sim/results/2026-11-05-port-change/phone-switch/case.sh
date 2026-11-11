#!/usr/bin/env bash
# 手机真机换网：用法 case.sh 名称 起始(wifi|cell) 方向 字节数 速率(或 -) 动作时刻:动作 ...
# 动作 off = 关 Wi-Fi（切到蜂窝），on = 开 Wi-Fi（连上后切回 Wi-Fi）。时刻从客户端启动算起，单位秒。
set -u
D="$TEMP/agent-net-phone"; A="$D/tools/platform-tools/adb.exe"; OUT="$D/runs"; mkdir -p "$OUT"
name=$1 start=$2 direction=$3 bytes=$4 rate=$5; shift 5
adbs() { MSYS_NO_PATHCONV=1 timeout 30 "$A" shell "$@"; }
route() { adbs 'ip -4 route get <上海云主机> 2>/dev/null | head -1' | tr -d '\r'; }
wifi() { adbs "cmd wifi set-wifi-enabled $1" > /dev/null; }
# 起始状态
if [ "$start" = wifi ]; then wifi enabled; else wifi disabled; fi
for i in $(seq 1 40); do r=$(route); case "$start:$r" in wifi:*wlan0*) break;; cell:*dev*) case "$r" in *wlan0*) ;; *) break;; esac;; esac; sleep 1; done
sleep 3
log="$OUT/$name.txt"; : > "$log"
echo "## $name start=$start direction=$direction bytes=$bytes rate=$rate actions=$* pc_start=$(date +%s.%N)" >> "$log"
echo "route before: $(route)" >> "$log"
# 手机上每 0.25 秒记一次去服务器的出口
adbs "cd /data/local/tmp/agent-net-test; nohup sh -c 'for i in \$(seq 1 480); do echo \"\$(date +%s.%N) \$(ip -4 route get <上海云主机> 2>/dev/null | head -1)\"; sleep 0.25; done' > route-$name.txt 2>&1 < /dev/null & echo \$! > route-$name.pid" 
args="--server <上海云主机>:47812 --direction $direction --bytes $bytes --notice no"
[ "$rate" != - ] && args="$args --rate-mbit $rate"
t0=$(date +%s.%N)
(MSYS_NO_PATHCONV=1 timeout 150 "$A" shell "cd /data/local/tmp/agent-net-test && ./migrate client $args 2>&1; echo client_exit \$?" > "$OUT/$name.client.txt" 2>&1) &
client=$!
for action in "$@"; do
  at=${action%%:*} what=${action##*:}
  now=$(date +%s.%N); wait_s=$(awk -v a="$at" -v n="$now" -v t="$t0" 'BEGIN{w=a-(n-t); if(w<0)w=0; print w}')
  sleep "$wait_s"
  echo "action $what at $(awk -v n="$(date +%s.%N)" -v t="$t0" 'BEGIN{printf "%.2f", n-t}')s pc=$(date +%s.%N)" >> "$log"
  if [ "$what" = off ]; then wifi disabled; else wifi enabled; fi
done
wait $client
echo "client done at $(awk -v n="$(date +%s.%N)" -v t="$t0" 'BEGIN{printf "%.2f", n-t}')s" >> "$log"
adbs "cd /data/local/tmp/agent-net-test && sleep 1; kill \$(cat route-$name.pid) 2>/dev/null; cat route-$name.txt" > "$OUT/$name.route-raw.txt" 2>&1
echo "route after: $(route)" >> "$log"
# 只留出口变化的那几行
awk -v t0="$t0" '{dev=""; for(i=1;i<=NF;i++) if($i=="dev") dev=$(i+1); if(dev!=last){printf "%.2fs dev=%s\n", $1-t0, (dev==""?"none":dev); last=dev}}' "$OUT/$name.route-raw.txt" >> "$log"
grep -E "^(done|dead|timeout):|client_exit|^established" "$OUT/$name.client.txt" >> "$log"
cat "$log"
