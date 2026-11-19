// 交互消息在应用里排队（写不进发送缓冲的部分留着下一步再写）时，从想发到对端读到的真实耗时。
// 用 sim/tests/streams.rs 里的 Pair、drain、upgraded：接到那个文件末尾，`cargo test --profile sim -p agent-net-sim --test streams queued_chat -- --ignored --nocapture`，跑完删掉。

#[test]
#[ignore]
fn queued_chat_delay() {
    let config = upgraded(Config::for_policy(RecoveryPolicy::Auto));
    let lossy = |bits_per_second, delay_us, jitter_us, loss, queue_us| LinkProfile { bits_per_second, delay_us, jitter_us, loss, queue_us, ..LinkProfile::default() };
    for (name, link) in [("手机", lossy(10_000_000, 50_000, 30_000, 0.03, 150_000)), ("跨境", lossy(4_000_000, 35_000, 5_000, 0.05, 200_000)), ("慢线", lossy(1_000_000, 60_000, 4_000, 0.01, 300_000))] {
        for bulk in [vec![Priority::Background], vec![Priority::Normal, Priority::Background]] {
            let mut all = Vec::new();
            for seed in 1..=3u64 {
                let mut pair = Pair::new(&config, link.clone(), link.clone(), seed);
                let chat = pair.a.open_stream(Priority::Interactive).unwrap();
                let files: Vec<u32> = bulk.iter().map(|&p| pair.a.open_stream(p).unwrap()).collect();
                let (message, chunk) = ([7u8; 200], [9u8; 4096]);
                let (mut sent_at, mut queued, mut chat_read) = (Vec::new(), 0usize, 0usize);
                let mut delays = Vec::new();
                while pair.now < 6_000_000 {
                    if pair.now >= sent_at.len() as u64 * 20_000 { sent_at.push(pair.now); queued += message.len(); }
                    while queued > 0 { let n = pair.a.send_stream(pair.now, chat, &message[..queued.min(200)]); if n == 0 { break; } queued -= n; }
                    for &f in &files { while pair.a.send_stream(pair.now, f, &chunk) == chunk.len() {} }
                    chat_read += drain(&mut pair.b, pair.now, chat);
                    for &f in &files { drain(&mut pair.b, pair.now, f); }
                    while (delays.len() + 1) * message.len() <= chat_read { delays.push(pair.now - sent_at[delays.len()]); }
                    pair.advance();
                }
                all.extend(delays);
            }
            all.sort_unstable();
            let at = |p: usize| all[all.len() * p / 100];
            eprintln!("{name} {:?}: 收到 {} 条 p50 {} p95 {} p99 {} 最长 {}", bulk, all.len(), at(50), at(95), at(99), all[all.len() - 1]);
        }
    }
}
