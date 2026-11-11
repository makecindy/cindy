//! INSTRUMENT: 新种子上和指定 KCP 配置比批量用时与额外字节。用法：hold <场景> <窗口> <KCP 标签> <种子数> <起始种子>
use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::kcp::{KcpPeer, KcpVariant};
use agent_net_sim::{CorePeer, Workload, run, scenarios};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let window: u32 = args[2].parse().unwrap();
    let (n, first): (u64, u64) = (args[4].parse().unwrap(), args[5].parse().unwrap());
    let s = scenarios().into_iter().find(|s| s.label == args[1]).unwrap();
    let v = KcpVariant::ALL.into_iter().find(|v| v.label == args[3]).unwrap();
    let config = Config { max_packet_size: 1400, send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..Config::for_policy(RecoveryPolicy::Auto) };
    let workload = Workload { a_to_b_bytes: 8 << 20, write_chunk: 4096, stall_limit_us: 600_000_000, ..Workload::default() };
    let total = (8u64 << 20) as f64;
    let (mut a, mut b, mut c, mut d) = (0.0, 0.0, 0.0, 0.0);
    for seed in first..first + n {
        let o = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), s.link.clone(), s.back.clone(), &workload, seed);
        let k = run(KcpPeer::variant(v, window as i32), KcpPeer::variant(v, window as i32), s.link.clone(), s.back.clone(), &workload, seed);
        a += o.finish_us as f64 / 1000.0; b += k.finish_us as f64 / 1000.0;
        c += (o.wire_bytes as f64 / total - 1.0) * 100.0; d += (k.wire_bytes as f64 / total - 1.0) * 100.0;
    }
    let n = n as f64;
    println!("{}\t{}\t{}\t{:.0}\t{:.1}\t{:.0}\t{:.1}", window, s.label, args[3], a / n, c / n, b / n, d / n);
}
