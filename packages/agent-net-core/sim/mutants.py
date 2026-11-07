#!/usr/bin/env python3
"""检验测试本身：往核心里注入已知 bug，确认测试会失败。

测试全绿只说明没发现问题；只有注入 bug 后测试变红，才能证明它真的在看守这条行为。
在临时副本里改代码，不碰工作区。用法：python3 sim/mutants.py [名称过滤]

下面几条不列在这里，第二条要百万种子才碰得到，其余不改变可观察行为：
- `accept_segment` 对旧分片返回 false：`una` 累计确认会兜底，只是少一次逐包确认。
- `poll_transmit` 里校验包到期时暂停加新数据：确认帧加数据帧刚好放得下、加校验帧多 1 字节时才会触发，
  默认的种子碰不到。去掉后只是校验包晚发，不影响数据完整。
- `parity_interval` 里确认限速后不发校验包：成片丢包的判断已经挡住了绝大多数，这个判断是第二道防线，
  模拟器的场景里去掉它差别在 1% 以内。
- 迟到确认只在没有 RTT 时采样：RTT 重置已经能纠正高估的样本，这个判断是第二道防线，2.8 万个种子里去掉它也不出错。
- `RttEstimator::observe` 里比平滑值低一半的样本直接采信：防的是断网后 RTT 高估、重试不够被判死，固定场景和 3000 个种子里去掉它都看不出差别。
- 窗口受限时抬高发送节奏：窗口满时节奏本来就跟着确认走，去掉后只有长往返路径慢 0.6%，单个种子分不清。
- `timeout_us` 的 `max_rto` 上限：退避已被 `MAX_BACKOFF_STEPS` 限住，这个上限只在 RTT 超过 260 毫秒时
  起作用，影响的是死路径的探测频率，不影响恢复时间。
- `noise.rs` 读完握手回复后清掉发起方的一次性私钥：`SecureConnection` 紧接着调用 `finish`，整个握手状态连同私钥一起丢掉，
  去掉这一行从外部看不出差别。保留它是为了直接使用 `Handshake` 的调用方。
- `secure.rs` 认证失败超过 2^36 个包就放弃连接：测试里造不出这么多包，只能靠代码审查。
- `secure.rs` 发回数据路径的路径验证回复填满到 `max_packet_size`：模拟器的链路不限包长，看不出差别。
  它顺便确认新路径这个方向能过满长度的包，过不了就验证不通过、数据留在原路径上，QUIC 也要求验证包填满。
- `secure.rs` 安静时只收到确认就当对端空闲：对端回过以后每 15 秒还会一来一回，两种写法只差传完后第一秒那一次探测，
  只有恰好在那一秒里悄悄换了地址才看得出。2026-11-05 加上 15 秒保活以前它能让连接失联，之后全量变异里不再变红。
- 最小 RTT 的记录时刻、发送节奏、上次超时时刻、交互流的轮次从建连时刻算起：第一次读到之前都会被覆盖，
  从 0 算起和从建连算起没有差别，所以代码里没有为它们设起点。
- `RECENT_ROUNDS` 从 8 改成 16：连续几轮排空不见效就重设基准，这个判断已经兜住了基准看得太久的问题，模拟器里只差在手机路径的延迟上。
- 降速阶段结束时不看开始时有没有排队，一律当成别人的队列：每轮开始时队列没在排就会清掉这个标记，差别只剩降速阶段里新排起来的队。
  2026-11-05 量过：守着它的 `own_queue_does_not_hide_random_loss` 从 54.04 秒变成 54.08 秒，共享矩阵 13 行有差别、方向不一
  （对 CUBIC 公平指数 0.89 → 0.94，四条 100M 12ms 0.95 → 0.93），上一版的代码上同样不变红；2026-11-03 记的“抓到”是超时。
- 认出看不出的排队时不收回补偿、收回后立刻放开：2026-11-05 持续满发时随机丢包 16% 以内不再补偿以后，认出时多半已经没有补偿可收。
  不收回时对比矩阵三种策略、共享矩阵两种定时器的差别都在 0.3% 以内，浅队列扫描 144 种组合只有一种差 1.8 个百分点（6.45% → 8.20%）；
  立刻放开介于两者之间。代码留着：没满发、或随机丢包超过 16% 时还用得上。
"""
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

MUTANTS = [
    ("连接号轮换：换网仍用旧号", "src/ids.rs",
     "        let fresh = self.remote.iter().find(|id|", "        let fresh = self.remote.iter().filter(|_| false).find(|id|"),
    ("连接号轮换：不作废", "src/ids.rs",
     "        self.local.retain(|id| !retired.contains(&id.sequence));", "        self.local.retain(|_| true);"),
    ("连接号轮换：丢包不重发", "src/ids.rs",
     "        self.due_at = Some(now_us + retry_us);", "        self.due_at = None;\n        let _ = retry_us;"),
    ("连接号轮换：仍在使用的号也作废", "src/ids.rs",
     "        if !self.routes.iter().any(|route| route.sequence == sequence) && !self.retired.contains(&sequence) {",
     "        if !self.retired.contains(&sequence) {"),
    ("干净路径也逐包确认", "src/connection.rs",
     "        self.config.recovery_policy != RecoveryPolicy::Lean\n            && self.congestion.window_bound_path()\n            && !self.limiter_suspected()\n            && (self.loss_ppm + self.late_ppm).max(floor) >= PARITY_MIN_LOSS_PPM\n",
     "        self.config.recovery_policy != RecoveryPolicy::Lean\n"),
    ("没见过丢包也提前发校验", "src/connection.rs",
     "            && self.congestion.is_starting()\n            && self.loss_ppm > 0\n", "            && self.congestion.is_starting()\n"),
    ("降速阶段不按实际送达打折", "src/congestion.rs",
     "(true, false) => recent * 3 / 4,", "(true, false) => self.btl_bw / 2,"),
    ("初始窗口发完干等第一个确认", "src/congestion.rs",
     "return if self.probe_sender_limited { self.max_cwnd } else { self.initial_cwnd };", "return self.initial_cwnd;"),
    ("宽松上限等到期才放开", "src/congestion.rs",
     "if reached && self.round_count >= self.rate_cap_round + CAP_RELEASE_ROUNDS", "if false && reached && self.round_count >= self.rate_cap_round + CAP_RELEASE_ROUNDS"),
    ("首字节版本位不校验", "src/wire.rs",
     "packet[0] & VERSION_MASK != VERSION_BITS", "false"),
    ("确认了超窗口的包（丢数据）", "src/connection.rs",
     "        if !accepted {\n            self.request_ack(now_us);\n            return Ok(());\n        }\n", ""),
    ("分片账目漏减", "src/connection.rs",
     "            self.send_buffered -= segment.data.len();\n", ""),
    ("确认后不释放在途名额", "src/connection.rs",
     "        if was_in_flight {\n            self.in_flight -= 1;\n        }\n", ""),
    ("接受确认未发送的包", "src/connection.rs",
     "        if largest >= self.next_packet {\n            return Err(PacketError::InvalidAck);\n        }\n", ""),
    ("接受超出已发送范围的 una", "src/connection.rs",
     "        if wire::expand(ack.una, self.snd_una, wire::ACK_NUMBER_BITS) > self.snd_sent {\n            return Err(PacketError::InvalidAck);\n        }\n", ""),
    ("确认区间不校验下溢", "src/connection.rs",
     "            if gap == 0 || run == 0 || span > low {\n                return Err(PacketError::InvalidAck);\n            }\n", ""),
    ("序号回绕还原错误", "src/wire.rs",
     "    if candidate + half <= expected {\n        candidate + window\n    } else if",
     "    if false {\n        candidate + window\n    } else if"),
    ("彻底断开也不判死", "src/connection.rs",
     "            self.dead = true;\n            return;\n", "            return;\n"),
    ("超出接收窗口也收下（内存失控）", "src/connection.rs",
     "        if sn - self.rcv_next >= window as u64 || self.unread_segments >= window * MAX_UNREAD_WINDOWS {\n            return false;\n        }\n", ""),
    ("未读数据没有上限", "src/connection.rs",
     "if sn - self.rcv_next >= window as u64 || self.unread_segments >= window * MAX_UNREAD_WINDOWS {", "if sn - self.rcv_next >= window as u64 {"),
    ("超大分片不校验", "src/connection.rs",
     "                Frame::Data { payload, .. } | Frame::Parity { payload, .. } if payload.len() > self.max_segment => {\n                    return Err(PacketError::Malformed);\n                }\n", ""),
    ("重传不优先最小序号", "src/connection.rs",
     "        while let Some(&(routine, sn)) = self.retransmit.first() {",
     "        while let Some(&(routine, sn)) = self.retransmit.last() {"),
    ("过期探测计时器造成空转", "src/connection.rs",
     "        if self.window_blocked() && self.in_flight == 0 {\n            consider(self.probe_at.unwrap_or(self.last_heard));\n        }",
     "        if let Some(at) = self.probe_at {\n            consider(at);\n        }"),
    ("PING 写入不查空间（越界）", "src/connection.rs",
     "if self.probe_due && used < out.len() && !parity_sent {", "if self.probe_due && !parity_sent {"),
    ("从不发窗口探测", "src/connection.rs",
     "                    self.probe_due = true;\n", ""),
    ("窗口打开时不主动通知", "src/connection.rs",
     "window_after >= half) {\n                self.request_ack(now_us);\n            }\n", "window_after >= half) {\n            }\n"),
    ("不受拥塞窗口限制", "src/connection.rs",
     "self.in_flight < self.config.send_window && self.bytes_in_flight < cwnd + parity_room",
     "self.in_flight < self.config.send_window"),
    ("不按节奏发送", "src/connection.rs",
     "} else if self.in_flight < UNPACED_SEGMENTS || self.congestion.can_send(now_us) {", "} else {"),
    ("随机丢包不补偿速率", "src/congestion.rs",
     "let kept = 1_000_000 - compensated;", "let kept = 1_000_000 - 0 * compensated;"),
    ("把所有包都算成低于容量", "src/congestion.rs",
     "self.mode == Mode::ProbeBw && PROBE_CYCLE[self.cycle_index] < 1000\n", "true\n"),
    ("窗口受限也算低于容量", "src/connection.rs",
     "let below_capacity = app_idle || self.congestion.sends_below_capacity();",
     "let below_capacity = app_limited || self.congestion.sends_below_capacity();"),
    ("被对端窗口卡住也下调带宽", "src/connection.rs",
     "let app_limited = !self.has_data_to_send();", "let app_limited = false;"),
    ("超时不算乱序余量", "src/connection.rs",
     "self.rtt.timeout_us(0, false, false) + self.reorder_delay_us", "self.rtt.timeout_us(0, false, false)"),
    ("误判后不放宽判丢窗口", "src/connection.rs",
     "            self.reorder_delay_us = self.reorder_delay_us.max(late + late / 4).min(self.rtt.srtt_us());\n", "            let _ = late;\n"),
    ("确认帧不带晚到的包", "src/wire.rs",
     "if stale && !late_packets.iter().any(|&number| low <= number && number <= high) {",
     "if stale {"),
    ("干净网络也捎带", "src/connection.rs",
     "count > 0 && bundling && (!small_copied || burst_losses) {", "count > 0 && (!small_copied || burst_losses) {"),
    ("丢包时不捎带", "src/connection.rs",
     "count > 0 && bundling && (!small_copied || burst_losses) {", "false {"),
    ("捎带最老而不是最新", "src/connection.rs",
     "let index = if stalled { offset } else { sent - 1 - offset };", "let index = offset;"),
    ("断网时不捎带最老的分片", "src/connection.rs",
     "let stalled = self.consecutive_timeouts >= BUNDLE_OLDEST_TIMEOUTS;", "let stalled = false;"),
    ("超时一次就当断网", "src/connection.rs",
     "const BUNDLE_OLDEST_TIMEOUTS: u32 = 2;", "const BUNDLE_OLDEST_TIMEOUTS: u32 = 1;"),
    ("丢包后不保持捎带", "src/connection.rs",
     "|| (self.loss_ppm < BUNDLE_LOSS_PPM && now_us >= self.bundle_until)\n", "|| self.loss_ppm < BUNDLE_LOSS_PPM\n"),
    ("开头不捎带", "src/connection.rs",
     "let bundling = self.loss_ppm >= BUNDLE_LOSS_PPM || now_us < self.bundle_until || warmup;", "let bundling = self.loss_ppm >= BUNDLE_LOSS_PPM || now_us < self.bundle_until;"),
    ("捎带份数不随丢包率增加", "src/connection.rs",
     "let mut copies = BUNDLE_COPIES.iter().find(|&&(loss, _)| self.loss_ppm >= loss).map_or(1, |&(_, copies)| copies);", "let mut copies = 1;"),
    ("窗口卡住时不发副本", "src/connection.rs",
     "        loss >= threshold\n", "        false && loss >= threshold\n"),
    ("不发校验包", "src/connection.rs",
     "        if (!warmup && !self.congestion.window_bound_path()) || !useful || self.congestion.is_rate_limited() || limiter_losses {\n", "        if true {\n"),
    ("干净网络也发校验包", "src/connection.rs",
     "let useful = (PARITY_MIN_LOSS_PPM..=PARITY_MAX_LOSS_PPM).contains(&holes);", "let useful = holes <= PARITY_MAX_LOSS_PPM;"),
    ("带宽是瓶颈时也发校验包", "src/connection.rs",
     "if (!warmup && !self.congestion.window_bound_path()) || !useful", "if !useful"),
    ("成片丢包也发校验包", "src/connection.rs",
     "        if self.lost_run_ppm >= PARITY_LOST_RUN_PPM {\n            return None;\n        }\n", ""),
    ("晚到的包不算空洞", "src/connection.rs",
     "let holes = if early { (self.loss_ppm + self.late_ppm).max(EARLY_PARITY_LOSS_PPM) } else if warmup { 50_000 } else { (self.loss_ppm + self.late_ppm).max(floor) };", "let holes = if early { self.loss_ppm.max(EARLY_PARITY_LOSS_PPM) } else if warmup { 50_000 } else { self.loss_ppm.max(floor) };"),
    ("抖动也算晚到", "src/connection.rs",
     "let late = self.is_slow(now_us, &packet) && self.largest_acked", "let late = self.largest_acked"),
    ("误判也算晚到", "src/connection.rs",
     "self.observe_lateness(self.is_slow(now_us, &lost.packet));", "self.observe_lateness(true);"),
    ("校验余量不够", "src/parity.rs",
     "const MARGIN_PERCENT: u64 = 100;", "const MARGIN_PERCENT: u64 = 10;"),
    ("校验覆盖太短", "src/parity.rs",
     "pub(crate) const MAX_COVERED: u64 = 64;", "pub(crate) const MAX_COVERED: u64 = 4;"),
    ("校验包挤占数据的在途额度", "src/connection.rs",
     "let parity_room = self.parity_interval().map_or(0, |interval| cwnd / interval as u64);", "let parity_room = 0;"),
    ("丢包率从 0 慢慢爬", "src/connection.rs",
     "self.loss_samples = (self.loss_samples + 1).min(LOSS_SMOOTHING);", "self.loss_samples = LOSS_SMOOTHING;"),
    ("解校验用错系数", "src/connection.rs",
     "rows[row][column] = parity::coefficient(parity.symbol, sn);", "rows[row][column] = parity::coefficient(parity.symbol, sn + 1);"),
    ("校验包没减掉已知分片", "src/connection.rs",
     "            if holes.contains(&sn) {\n                continue;\n            }\n            let Some((segment, headed)) = self.received_segment(sn) else {", "            if holes.contains(&sn) || sn % 2 == 0 {\n                continue;\n            }\n            let Some((segment, headed)) = self.received_segment(sn) else {"),
    ("读走的分片不留给校验", "src/connection.rs",
     "const MAX_HISTORY_SEGMENTS: usize = parity::MAX_COVERED as usize + 16;", "const MAX_HISTORY_SEGMENTS: usize = 0;"),
    ("受保护的包不等校验结果", "src/connection.rs",
     "        Some(sent_at + self.rtt.loss_delay_us() + self.config.ack_delay_us)\n", "        let _ = sent_at;\n        None\n"),
    ("校验包算错长度也收下", "src/connection.rs",
     "if complete && sized && self.accept_segment(sn, &restored[..length], headed) {",
     "let _ = (complete, sized);\n            if self.accept_segment(sn, &restored[..length.min(restored.len())], headed) {"),
    ("启动不看队列", "src/congestion.rs",
     "if self.mode == Mode::Startup && self.queue_is_building() {", "if false {"),
    ("第一批包不测速", "src/congestion.rs",
     "let delivery_rate = sample.delivery_rate.max(self.train_rate(now_us, sample, delivered));", "let delivery_rate = sample.delivery_rate;"),
    ("巡航不排空队列", "src/congestion.rs",
     "const QUEUE_DRAIN_GAIN: u64 = 900;", "const QUEUE_DRAIN_GAIN: u64 = 1000;"),
    ("发现不了限速", "src/congestion.rs",
     "        self.sample_period(now_us, delivered);\n", ""),
    ("一次测量就收紧上限", "src/congestion.rs",
     "let confirmed = calm_packets >= PERIOD_MIN_CALM_PACKETS && (strong || self.last_period_rate.abs_diff(rate) <= self.last_period_rate / 8);", "let confirmed = true;"),
    ("迟到的确认不算 RTT 样本", "src/connection.rs",
     "            if self.rtt.srtt_us() == 0 {\n                self.rtt.observe(now_us.saturating_sub(lost.packet.sent_at));\n            }\n", ""),
    ("发包前不处理到期判丢", "src/connection.rs",
     "        if self.loss_deadline().is_some_and(|at| at <= now_us) || self.timeout_deadline().is_some_and(|at| at <= now_us) {\n            self.tick(now_us);\n            if self.dead {\n                return None;\n            }\n        }\n", ""),
    ("断网时段也算容量", "src/congestion.rs",
     "        if elapsed > PERIOD_STALE_FACTOR * period {\n", "        if false {\n"),
    ("重置后留着旧的一轮 RTT", "src/congestion.rs",
     "            self.round_min_rtt_us = u64::MAX;\n            self.last_round_min_rtt_us = u64::MAX;\n            self.recent_round_rtts = [u64::MAX; RECENT_ROUNDS];\n            self.round_rtt_samples = 0;\n            self.full_bw = 0;", "            self.full_bw = 0;"),
    ("断网时继续重发整个窗口", "src/congestion.rs",
     "        self.recovering = consecutive >= RECOVERY_TIMEOUTS;\n", ""),
    ("短中断退避太长", "src/rtt.rs",
     "const SHORT_BACKOFF_STEPS: u32 = 2;", "const SHORT_BACKOFF_STEPS: u32 = 4;"),
    ("断网时退避不封顶", "src/rtt.rs",
     "const MAX_BACKOFF_STEPS: u32 = 4;", "const MAX_BACKOFF_STEPS: u32 = 12;"),
    ("超时只判最老的包", "src/connection.rs",
     "            let age = self.timeout_age_us();\n", "            let age = self.rtt.timeout_us(self.consecutive_timeouts, false, false) + self.reorder_delay_us;\n"),
    ("退避按包计", "src/connection.rs",
     "        Some(aged.max(self.last_timeout_at + backoff + self.reorder_delay_us))\n", "        Some(aged)\n"),
    ("流：不带流头的分片猜成默认流", "src/connection.rs",
     "let Some((stream, seq)) = previous else { return };", "let (stream, seq) = previous.unwrap_or((DEFAULT_STREAM, 0));"),
    ("流：结束标记不生效", "src/connection.rs",
     "if fin && stream != DEFAULT_STREAM {", "if false && fin && stream != DEFAULT_STREAM {"),
    ("流：探测时不补发额度", "src/connection.rs",
     "                        state.grant_repeats = state.grant_repeats.max(1);\n", ""),
    ("流：开流数量不设限", "src/connection.rs",
     "self.recv_streams.contains_key(&header.stream) || self.recv_streams.len() < self.config.max_streams as usize", "true"),
    ("流：发送不看额度", "src/connection.rs",
     "else { stream.next_seq < stream.credit_end }", "else { let _ = stream; true }"),
    ("流：读了数据不更新额度", "src/connection.rs",
     "            self.grant_credit(now_us, stream);\n            self.close_if_drained(stream);\n", "            self.close_if_drained(stream);\n"),
    ("流：额度更新太慢", "src/connection.rs",
     "const GRANT_FRACTION: u64 = 8;", "const GRANT_FRACTION: u64 = 2;"),
    ("流：低优先级可以饿死", "src/stream.rs",
     "if self.high_run >= STARVATION_LIMIT", "if false && self.high_run >= STARVATION_LIMIT"),
    ("流：同级的流不轮转", "src/stream.rs",
     "self.quantum_left[rank] = if self.last[rank] == Some(id) { self.quantum_left[rank].saturating_sub(1) } else { ROUND_QUANTUM - 1 };", "self.quantum_left[rank] = ROUND_QUANTUM;"),
    ("流：每个分片都带流头", "src/connection.rs",
     "let continuing = tail_stream == (id, state.next_seq);", "let continuing = false;"),
    ("流：发送端不释放用完的流", "src/connection.rs",
     "                    self.send_streams.remove(&segment.stream);\n", ""),
    ("流：调整优先级不生效", "src/connection.rs",
     ".map(|state| state.priority = priority).is_some()", ".map(|_| ()).is_some()"),
    ("流：不给交互流留窗口", "src/connection.rs",
     "let reserve = if self.mixed_traffic { (self.config.send_window as u64 / INTERACTIVE_WINDOW_RESERVE).max(1) } else { 0 };", "let reserve = 0u64;"),
    ("流：交互消息也要排节奏", "src/connection.rs",
     "            && self.in_flight < self.config.send_window\n            && self.next_is_urgent()\n", "            && false\n"),
    ("流：新消息排在重传后面", "src/connection.rs",
     "if !matches!(retransmit, Some((false, _)))\n", "if false && !matches!(retransmit, Some((false, _)))\n"),
    ("流：丢的交互消息不优先重传", "src/connection.rs",
     "Segment { data, stream: id, headed, urgent, acked: false,", "Segment { data, stream: id, headed, urgent: false, acked: false,"),
    ("流：混发时启动不放轻", "src/congestion.rs",
     "const LOW_QUEUE_STARTUP_GAIN: u64 = 1350;", "const LOW_QUEUE_STARTUP_GAIN: u64 = 2885;"),
    ("流：混发时在途不收紧", "src/congestion.rs",
     "const LOW_QUEUE_CWND_GAIN: u64 = 1250;", "const LOW_QUEUE_CWND_GAIN: u64 = 2000;"),
    ("流：混发时巡航不让路", "src/congestion.rs",
     "const LOW_QUEUE_CRUISE_GAIN: u64 = 970;", "const LOW_QUEUE_CRUISE_GAIN: u64 = 1000;"),
    ("流：混发时探测不放轻", "src/congestion.rs",
     "const LOW_QUEUE_PROBE_GAIN: u64 = 1050;", "const LOW_QUEUE_PROBE_GAIN: u64 = 1250;"),
    ("流：压低队列时拿历史最低当基准", "src/congestion.rs",
     "        if !self.low_queue {\n            return self.min_rtt_us;\n        }\n", "        if true {\n            return self.min_rtt_us;\n        }\n"),
    ("流：低优先级重传不算前进", "src/connection.rs",
     "                    self.scheduler.record_retransmission();\n", ""),
    ("流：交互消息放行不限量", "src/connection.rs",
     "self.urgent_round_bytes < INTERACTIVE_ROUND_SEGMENTS * self.config.max_packet_size\n", "self.urgent_round_bytes < usize::MAX\n"),
    ("流：路径变慢也一直降速", "src/congestion.rs",
     "            if floor.saturating_mul(32) >= self.queue_check_rtt.saturating_mul(31) {\n                self.recent_round_rtts = [floor; RECENT_ROUNDS];\n            }\n", ""),
    ("共享：迟到的发送节奏不补", "src/congestion.rs",
     "        let earliest = if self.pacing_behind {\n", "        let earliest = if false && self.pacing_behind {\n"),
    ("流：等确认耽误的节奏不补", "src/congestion.rs",
     "now_us.saturating_sub(interval * LOW_QUEUE_CATCH_UP_PACKETS)", "now_us"),
    ("共享：探测见到丢包也不结束", "src/congestion.rs",
     "let lost_enough = !self.low_queue && self.probe_lost > 0 && now_us.saturating_sub(self.cycle_started) >= self.min_rtt_us * PROBE_LOSS_RTTS;", "let lost_enough = false;"),
    ("共享：让路窗口下限回到全速的下限", "src/congestion.rs",
     "let floor = self.fair_packet * FAIR_MIN_PACKETS;", "let floor = self.min_cwnd;"),
    ("共享：让路小窗口涨得快", "src/congestion.rs",
     "const FAIR_SMALL_WINDOW_DIVISOR: u64 = 64;", "const FAIR_SMALL_WINDOW_DIVISOR: u64 = 16;"),
    ("共享：让路窗口保底不涨", "src/congestion.rs",
     "let steady = self.fair_cwnd + (self.fair_packet * 53 / 100).min(self.fair_cwnd / FAIR_SMALL_WINDOW_DIVISOR);", "let steady = self.fair_cwnd;"),
    ("共享：让路大窗口涨得快", "src/congestion.rs",
     "(self.fair_packet * 53 / 100).min(", "(self.fair_packet * 2).min("),
    ("共享：让路接手窗口太小", "src/congestion.rs",
     "self.fair_cwnd = self.bdp().max(floor);", "self.fair_cwnd = (self.bdp() / 3).max(floor);"),
    ("共享：让路接手后接着减窗口", "src/congestion.rs",
     "const FAIR_SETTLE_ROUNDS: u8 = 2;", "const FAIR_SETTLE_ROUNDS: u8 = 0;"),
    ("共享：让路把超时当拥塞", "src/connection.rs",
     "self.stats.timeout_losses += 1;", "self.stats.timeout_losses += 1; self.congestion.on_overtaken(1400);"),
    ("共享：让路按小包算窗口", "src/congestion.rs",
     "self.fair_packet = packet_bytes.max(FAIR_UNIT_BYTES);", "self.fair_packet = packet_bytes.max(1);"),
    ("共享：让路配置不生效", "src/connection.rs",
     "if config.bandwidth_share == BandwidthShare::Fair {", "if false {"),
    ("共享：让路见到丢包不减速", "src/congestion.rs",
     "        if self.fair_round_lost > 0 {\n            self.fair_w_max = self.fair_cwnd;", "        if false {\n            self.fair_w_max = self.fair_cwnd;"),
    ("共享：让路窗口不涨回来", "src/congestion.rs",
     "        } else if !app_limited {\n            let w_max", "        } else if false && !app_limited {\n            let w_max"),
    ("共享：默认改成让路", "src/connection.rs",
     "            bandwidth_share: BandwidthShare::Full,\n", "            bandwidth_share: BandwidthShare::Fair,\n"),
    ("共享：等确认的时间也算迟到", "src/connection.rs",
     "        if !self.within_flight_limits() {\n            self.congestion.stop_pacing_catch_up();\n        } else if", "        if !self.within_flight_limits() {\n        } else if"),
    ("共享：排队时的丢包也算随机丢包", "src/congestion.rs",
     "(self.low_queue || !self.queue_is_building())", "true"),
    ("共享：持续满发时照样补偿", "src/congestion.rs",
     "let random = if self.saturated_rounds >= SATURATED_ROUNDS {", "let random = if false {"),
    ("共享：持续满发时按 20% 封顶补偿（上一版）", "src/congestion.rs",
     "{ saturated_compensation(random) } else { random };", "{ random.min(SATURATED_MAX_COMPENSATION_PPM) } else { random };"),
    ("持续满发时完全不补偿", "src/congestion.rs",
     "    (random_ppm.saturating_sub(SATURATED_FREE_LOSS_PPM) * 5 / 4).min(SATURATED_MAX_COMPENSATION_PPM)\n", "    0 * random_ppm\n"),
    ("共享：别人的队列按排队判断的余量认", "src/congestion.rs",
     "        (self.min_rtt_us / 32).max(self.rtt_jitter_us * 3).clamp(FOREIGN_MARGIN_MIN_US, QUEUE_MARGIN_MAX_US)\n",
     "        self.queue_margin_us()\n"),
    ("共享：别人的队列里降速丢的包也当随机丢包", "src/congestion.rs",
     "            && !self.overflowing\n            && !self.queue_is_foreign()\n", "            && !self.overflowing\n"),
    ("共享：探测撞到丢包后不留余量", "src/congestion.rs",
     "            Mode::ProbeBw if PROBE_CYCLE[self.cycle_index] == 1000 && self.gentle_probes > 0 => HEADROOM_CRUISE_GAIN,\n", ""),
    ("流：单独的交互流也压低队列", "src/connection.rs",
     "self.mixed_traffic = active(self.last_interactive_at) && active(self.last_other_at);", "self.mixed_traffic = active(self.last_interactive_at);"),
    ("到达间隔从 0 算起", "src/connection.rs",
     "        self.last_arrival_at = now_us;\n        self.largest_acked_sent_at = now_us;\n    }", "        self.largest_acked_sent_at = now_us;\n    }"),
    ("已确认的最晚发送时刻从 0 算起", "src/connection.rs",
     "        self.largest_acked_sent_at = now_us;\n    }", "    }"),
    ("拿 0 当校验包还没发", "src/connection.rs",
     "        Some(sent_at + self.rtt.loss_delay_us() + self.config.ack_delay_us)",
     "        (sent_at != 0).then(|| sent_at + self.rtt.loss_delay_us() + self.config.ack_delay_us)"),
    ("统计段不从第一次发包算起", "src/congestion.rs",
     "        if self.btl_bw == 0 && self.first_flight_sent == 0 {\n            self.period_started = now_us;\n        }\n", ""),
    ("丢得比送达多时带宽样本一直不老化", "src/congestion.rs",
     "(!outage || self.outage_rounds > OUTAGE_HOLD_ROUNDS)", "!outage"),
    ("排着的队都当成别人的", "src/congestion.rs",
     "(self.foreign_queue && self.queue_above(self.foreign_margin_us()))", "self.queue_above(self.foreign_margin_us())"),
    ("共享：看不出的排队里降速丢包照常算", "src/congestion.rs",
     [("            && !self.overflowing\n            && !self.queue_is_foreign()\n", "            && !self.queue_is_foreign()\n"),
      ("(self.foreign_queue && self.queue_above(self.foreign_margin_us())) || self.overflowing", "self.foreign_queue && self.queue_above(self.foreign_margin_us())")]),
    ("共享：看不出的排队里限速门槛按清理后的估计算", "src/congestion.rs",
     "let p = if self.overflowing { (self.random_loss_ppm as u64).max(calm) } else { self.random_loss_ppm as u64 };",
     "let p = self.random_loss_ppm as u64;"),
    ("共享：看不出的排队按周期数淡出", "src/congestion.rs",
     "let divisor = (OVERFLOW_MEMORY_US / (CYCLE_RTTS * self.min_rtt_us).max(1)).clamp(OVERFLOW_DECAY_MIN, OVERFLOW_DECAY_MAX);",
     "let divisor = OVERFLOW_DECAY_MAX;"),
    ("共享：看不出的排队不看周期之间的差别", "src/congestion.rs",
     "let dispersion = (self.observed_variance.saturating_mul(1000) / self.expected_variance.max(1)).max(1000);",
     "let dispersion = 1000;"),
    ("别人的队列里送达的包也不算", "src/congestion.rs",
     "        if !trusted && !(foreign && !lost) {", "        if !trusted {"),
    ("加密：不查重放窗口", "src/secure.rs",
     "        let duplicate = !self.replay.is_fresh(number);", "        let duplicate = false;"),
    ("加密：认证前就记入重放窗口", "src/secure.rs",
     "        let Some(slot) = keys.recv.slot(&self.crypto, number) else {",
     "        self.replay.mark(number);\n        let Some(slot) = keys.recv.slot(&self.crypto, number) else {"),
    ("加密：防重放窗口前移时不清旧位", "src/secure.rs",
     "                for cleared in largest + 1..number {", "                for cleared in largest + 1..largest + 1 {"),
    ("加密：包头不参与认证", "src/secure.rs",
     [("let tag = self.crypto.seal(key, number, header, body);", "let tag = self.crypto.seal(key, number, &[], body);"),
      ("if !self.crypto.open(keys.recv.key(slot), number, header, body, &tag) {", "if !self.crypto.open(keys.recv.key(slot), number, &[], body, &tag) {")]),
    ("加密：未认证的包也算确认", "src/secure.rs",
     "        let Some(slot) = keys.recv.slot(&self.crypto, number) else {",
     "        *confirmed = true;\n        let Some(slot) = keys.recv.slot(&self.crypto, number) else {"),
    ("加密：确认前就发数据", "src/secure.rs",
     "                if !*confirmed {\n                    return None;\n                }\n", ""),
    ("加密：回复按自己的包长填充", "src/secure.rs",
     "let total = config.max_packet_size.min(initiation.len());", "let total = config.max_packet_size;"),
    ("加密：握手完成不发探测", "src/secure.rs",
     "        // 响应方要见到这一端的数据包才确认，没有数据要发时也要让它尽快确认。\n        self.connection.ping();\n", ""),
    ("加密：重发的请求不再回复", "src/secure.rs",
     "            response.due = true;\n", ""),
    ("加密：伪造的回复打断握手", "src/secure.rs",
     "        handshake.read_second(&self.crypto, packet.get(RESPONSE_PREFIX..).unwrap_or(&[]), &mut plain).map_err(packet_error)?;",
     "        if let Err(error) = handshake.read_second(&self.crypto, packet.get(RESPONSE_PREFIX..).unwrap_or(&[]), &mut plain) {\n            self.dead = true;\n            return Err(packet_error(error));\n        }"),
    ("加密：准入不校验 mac1", "src/admission.rs",
     "    same(&mac(crypto, key, &packet[..end]), &packet[end..end + MAC_LEN])", "    true"),
    ("加密：准入忙时不要 cookie", "src/admission.rs",
     "        if gate.mac2_ok(packet, &current) || gate.mac2_ok(packet, &previous) {", "        if true {"),
    ("加密：准入忙时不按地址限流", "src/admission.rs",
     "            return if self.limit(now_us, address) { Verdict::Process } else { Verdict::Throttled };", "            return Verdict::Process;"),
    ("加密：准入拿到 cookie 不马上重发", "src/secure.rs",
     "            initiation.next_send_at = now_us;\n", ""),
    ("加密：关闭通知收到不停", "src/secure.rs",
     "            self.closed_by_peer = true;\n            self.dead = true;\n", "            self.closed_by_peer = true;\n"),
    ("加密：关闭通知只发一个", "src/secure.rs",
     "const CLOSE_COPIES: u8 = 2;", "const CLOSE_COPIES: u8 = 1;"),
    ("加密：端点关连接不告诉对端", "src/endpoint.rs",
     "        slot.connection.close();\n", ""),
    ("加密：同时发起时双方都让", "src/secure.rs",
     "        if self.local_static > self.remote_static {", "        if false {"),
    ("加密：迟到的同时发起请求当成新连接", "src/secure.rs",
     "            self.known_ephemeral = ephemeral;\n            return Ok(());", "            return Ok(());"),
    ("加密：不保留上一个接收密钥", "src/secure.rs",
     "} else if epoch + 1 == self.epoch && self.previous.is_some() {", "} else if false {"),
    ("加密：换密钥后接收方不前移", "src/secure.rs",
     "            keys.recv.advance();\n", ""),
    ("加密：发送方向不换密钥", "src/secure.rs",
     "        while self.epoch < epoch_of(number) {", "        while false && self.epoch < epoch_of(number) {"),
    ("加密：不检查握手超时", "src/secure.rs",
     "            Some(since) if now_us.saturating_sub(since) >= self.config.dead_after_us => self.dead = true,",
     "            Some(since) if false && now_us.saturating_sub(since) >= self.config.dead_after_us => self.dead = true,"),
    ("连接号：数据包里写自己的号", "src/secure.rs",
     "        out[wire::PACKET_HEADER_LEN..DATA_PREFIX].copy_from_slice(&self.remote_id.to_be_bytes());",
     "        out[wire::PACKET_HEADER_LEN..DATA_PREFIX].copy_from_slice(&self.config.connection_id.to_be_bytes());"),
    ("连接号：握手时不告诉对端", "src/secure.rs",
     "        handshake.write_first(&crypto, &padded(config.connection_id, payload,", "        handshake.write_first(&crypto, &padded(0, payload,"),
    ("换路径：不验证就把数据换过去", "src/secure.rs",
     "        if result.is_ok() && newest && self.paths.observe(now_us, path, self.config.initial_rto_us, same_route) {",
     "        if result.is_ok() && newest && path != self.paths.active {\n            self.paths.active = path;\n            self.connection.on_path_change(now_us);\n        }\n        if result.is_ok() && newest && self.paths.observe(now_us, path, self.config.initial_rto_us, same_route) {"),
    ("换路径：只能同时验证一条", "src/secure.rs",
     "        if self.candidates.len() == MAX_CANDIDATES {", "        if !self.candidates.is_empty() {"),
    ("换路径：降速阶段的节奏能压到零", "src/congestion.rs",
     "recent >= MIN_LIMITER_EVIDENCE_RATE && recent < self.btl_bw / 2", "recent < self.btl_bw / 2"),
    ("换路径：不守放大限制", "src/secure.rs",
     "        let room = candidate.received.saturating_mul(AMPLIFICATION_FACTOR).saturating_sub(candidate.sent);",
     "        let room = u64::MAX / 2;"),
    ("换路径：验证通过不重量往返和带宽", "src/secure.rs",
     "                } else {\n                    self.connection.on_path_change(now_us);\n                }\n                self.stats.migrations += 1;",
     "                } else {\n                }\n                self.stats.migrations += 1;"),
    ("换路径：原路径的包不取消验证", "src/secure.rs",
     "        if path == self.active {\n            self.candidates.clear();\n            return false;", "        if path == self.active {\n            return false;"),
    ("换路径：验证超时不放弃", "src/secure.rs",
     "        self.candidates.retain(|candidate| candidate.deadline > now_us);", "        let _ = now_us;"),
    ("换路径：验证包不重发", "src/secure.rs",
     "candidate.challenges < MAX_CHALLENGES && candidate.due_at <= now_us", "candidate.challenges < 1 && candidate.due_at <= now_us"),
    ("换路径：被验证的一端不重量往返和带宽", "src/secure.rs",
     "                    self.moved_at = Some(now_us);\n                    self.connection.on_path_change(now_us);\n", "                    self.moved_at = Some(now_us);\n"),
    ("换路径：知道换了网络也不马上发包", "src/secure.rs",
     "            self.connection.on_path_change(now_us);\n            self.ping();\n", "            self.connection.on_path_change(now_us);\n"),
    ("换路径：只含验证的包也交给可靠层", "src/secure.rs",
     "        if wire::is_path_frame(frames) {", "        if false && wire::is_path_frame(frames) {"),
    ("换路径：只换端口也从头量", "src/secure.rs",
     "                if same_route {\n                    self.connection.on_port_change();", "                if false {\n                    self.connection.on_port_change();"),
    ("换路径：只换端口时不补确认", "src/secure.rs",
     "                    self.connection.ack_now(now_us);\n", ""),
    ("换路径：被验证时不看只换端口的标记", "src/secure.rs",
     "                if same_route && path == self.paths.active {", "                if false && path == self.paths.active {"),
    ("换路径：被验证时不暂缓超时", "src/secure.rs",
     "                    self.connection.hold_timeouts(now_us + 2 * self.connection.srtt_us());\n", ""),
    ("换路径：只换端口的验证不带标记", "src/wire.rs",
     "        PathFrame::Challenge { same_route: true } => FRAME_PATH_CHALLENGE_SAME_ROUTE,", "        PathFrame::Challenge { same_route: true } => FRAME_PATH_CHALLENGE,"),
    ("驱动：同一个 IP 换了端口也当成换了网络", "udp/src/lib.rs",
     "active.ip() == from.ip() && active.port() != from.port()", "false && active.port() != from.port()"),
    ("换路径：最新包的重复从别处来也不验证", "src/secure.rs",
     "        if duplicate && (self.replay.largest != Some(number) || path == self.paths.active) {", "        if duplicate {"),
    ("换路径：任何重复包从别处来都去验证", "src/secure.rs",
     "        if duplicate && (self.replay.largest != Some(number) || path == self.paths.active) {", "        if duplicate && path == self.paths.active {"),
    ("安静探测：从不探测", "src/secure.rs",
     "        if self.connection.bytes_in_flight() > 0 {\n            return None;\n        }\n        let heard", "        if true {\n            return None;\n        }\n        let heard"),
    ("安静探测：对端回过一次就再也不探测", "src/secure.rs",
     "            return Some(heard + self.config.dead_after_us / 2);", "            return None;"),
    ("安静探测：对端回了也一直探测", "src/secure.rs",
     "let answered = self.silence_sent_at.is_some_and(|sent| heard > sent && self.connection.last_data_at() <= sent);",
     "let answered = false && self.silence_sent_at.is_some_and(|sent| heard > sent && self.connection.last_data_at() <= sent);"),
    ("安静探测：重试间隔翻倍、最多 4 倍（上一版）", "src/secure.rs",
     "        let at = last + base;", "        let at = last + base * ((last - heard) / base).clamp(1, 4);"),
    ("安静探测：重试间隔翻倍、最多 2 倍", "src/secure.rs",
     "        let at = last + base;", "        let at = last + base * ((last - heard) / base).clamp(1, 2);"),
    ("往返：判丢后才到的确认不采样", "src/connection.rs",
     "        } else if let Some(sent_at) = late_sample {", "        } else if let Some(sent_at) = late_sample.filter(|_| false) {"),
    ("加密：回复里漏掉 se", "src/noise.rs",
     "            let se = checked_dh(crypto.dh_ephemeral(&ephemeral, &self.remote_static))?;\n            state.mix_key(crypto, &se.0);\n",
     "            let se = checked_dh(crypto.dh_ephemeral(&ephemeral, &self.remote_static))?;\n            let _ = se;\n"),
    ("加密：协议名不进握手哈希", "src/noise.rs",
     "        name.extend_from_slice(C::HASH.as_bytes());\n", ""),
    ("加密：接受全零的 DH 结果", "src/noise.rs",
     "        Some(shared) if shared != [0; PUBLIC_KEY_LEN] => Ok(Secret(shared)),", "        Some(shared) => Ok(Secret(shared)),"),
]


def test_targets(name):
    if name.startswith("连接号轮换："):
        return ["--test", "secure", "connection_id"]
    if name.startswith("加密："):
        return ["--test", "secure"]
    if name.startswith("连接号："):
        return ["--test", "secure", "--test", "migration"]
    if name.startswith(("换路径：", "安静探测：")):
        return ["--test", "migration"]
    if name.startswith("驱动："):
        return ["--test", "udp"]
    if name.startswith("流："):
        return ["--test", "streams"]
    if name.startswith("共享："):
        return ["--test", "sharing"]
    return ["--test", "reliability", "--test", "streams", "--test", "sharing"]


def run_mutant(name, relative, before, after, shared_target):
    with tempfile.TemporaryDirectory() as directory:
        copy = pathlib.Path(directory) / "core"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("target", "vendor-test-only", "__pycache__"))
        path = copy / relative
        source = path.read_text(encoding="utf8")
        # 一个变异可以同时改几处，例如收发两端一起改。
        for old, new in before if isinstance(before, list) else [(before, after)]:
            if source.count(old) != 1:
                return "invalid", f"pattern matched {source.count(old)} times"
            source = source.replace(old, new)
        path.write_text(source, encoding="utf8")
        environment = dict(os.environ, CARGO_TARGET_DIR=shared_target, AGENT_NET_SEEDS="3000")
        # 放进独立进程组：超时时要连 cargo 启动的测试程序一起杀掉，否则卡死的变异体会一直占 CPU。
        process = subprocess.Popen(
            ["cargo", "test", "--profile", "sim", "-p", "agent-net-sim", *test_targets(name)],
            cwd=copy, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            start_new_session=os.name != "nt",
        )
        try:
            output, _ = process.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            # Windows 没有进程组，用 taskkill 连子进程一起结束。
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            return "caught", "hang detected"
        if process.returncode == 0:
            return "survived", ""
        if "could not compile" in output:
            return "invalid", output[-400:]
        failed = [line.split()[1] for line in output.splitlines() if line.startswith("test ") and "FAILED" in line]
        return "caught", ", ".join(failed) or "crashed"


def main():
    pattern = sys.argv[1] if len(sys.argv) > 1 else ""
    survivors = 0
    with tempfile.TemporaryDirectory() as shared_target:
        # 全部跑完要两个多小时。`AGENT_NET_MUTANT_SHARD=0/4` 这样分片，几个进程一起跑。
        shard, shards = map(int, os.environ.get("AGENT_NET_MUTANT_SHARD", "0/1").split("/"))
        for index, (name, relative, before, *after) in enumerate(MUTANTS):
            after = after[0] if after else None
            if (pattern and pattern not in name) or index % shards != shard:
                continue
            verdict, detail = run_mutant(name, relative, before, after, shared_target)
            survivors += verdict != "caught"
            print(f"{verdict:<9} {name}  {detail[:90]}", flush=True)
    sys.exit(1 if survivors else 0)


if __name__ == "__main__":
    main()
