//! 归档用：换网场景的恢复时间、新路径速度和攻击下的结果，按最终代码重跑一遍打印出来。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Report, Scenario, random_scenario, run_moves};

fn wifi() -> LinkProfile { LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() } }
fn cellular() -> LinkProfile { LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() } }
fn config() -> Config { Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() } }
fn scenario(up: LinkProfile, down: LinkProfile, moves: Vec<Move>, upload_bytes: u64, download_bytes: u64, attack: Attack) -> Scenario {
    Scenario { seed: 1, config: config(), up, down, moves, upload_bytes, download_bytes, attack, time_limit_us: 600_000_000 }
}
fn after(s: &Scenario, r: &Report) -> f64 {
    let step = &s.moves[0]; let d = r.delivered_at_moves[0];
    let left = (s.upload_bytes - d[0]) + (s.download_bytes - d[1]);
    left as f64 * 8.0 / (r.finish_us - step.at_us - r.recoveries_us[0].unwrap_or(0)) as f64
}
fn main() {
    println!("## Wi-Fi 50M 10ms → 蜂窝 10M 35ms 丢 0.5%，第 1.5 秒加断网时长后换");
    println!("| 断网 | 客户端知道 | 方向 | 完成秒 | 恢复毫秒 | 换后 Mbit/s | 服务端 验证/换过去/失败 | 安静探测 客户端/服务端 |");
    for outage in [0u64, 1_000_000, 3_000_000] { for noticed in [true, false] { for (up, down, name) in [(12_000_000u64, 1u64, "上传"), (0, 12_000_000, "下载"), (10_000_000, 10_000_000, "双向")] {
        let s = scenario(wifi(), wifi(), vec![Move { at_us: 1_500_000 + outage, outage_us: outage, up: cellular(), down: cellular(), noticed }], up, down, Attack::None);
        let r = run_moves(&s); let (sv, _) = r.server.unwrap(); let (cl, _) = r.client.unwrap();
        println!("| {:.0} 秒 | {} | {name} | {:.2} | {:.0} | {:.1} | {}/{}/{} | {}/{} |", outage as f64 / 1e6, if noticed { "是" } else { "否" }, r.finish_us as f64 / 1e6, r.recoveries_us[0].unwrap_or(0) as f64 / 1e3, after(&s, &r), sv.path_challenges, sv.migrations, sv.path_failures, cl.silence_pings, sv.silence_pings);
    }}}
    println!("\n## 快慢网络互换，下载 40 MB，第 2 秒换");
    println!("| 从 → 到 | 客户端知道 | 换后 Mbit/s | 新线路的 |");
    let link = |rate| LinkProfile { bits_per_second: rate, delay_us: 20_000, queue_us: 40_000, ..LinkProfile::default() };
    for (from, to) in [(100_000_000u64, 5_000_000u64), (5_000_000, 100_000_000)] { for noticed in [true, false] {
        let s = scenario(link(from), link(from), vec![Move { at_us: 2_000_000, outage_us: 0, up: link(to), down: link(to), noticed }], 0, 40_000_000, Attack::None);
        let r = run_moves(&s); let rate = after(&s, &r);
        println!("| {} → {} | {} | {:.1} | {:.0}% |", from / 1_000_000, to / 1_000_000, if noticed { "是" } else { "否" }, rate, rate * 1e6 / to as f64 * 100.0);
    }}
    println!("\n## 攻击：Wi-Fi 上传或下载 8 MB，不换网");
    println!("| 攻击 | 方向 | 完成秒 | 和没有攻击比 | 发往攻击者 / 攻击者送来 字节 | 验证轮数 | 换过去 |");
    for (up, down, name) in [(8_000_000u64, 1u64, "上传"), (0, 8_000_000, "下载")] {
        let base = run_moves(&scenario(wifi(), wifi(), vec![], up, down, Attack::None));
        println!("| 无 | {name} | {:.2} | 1.00 | 0 / 0 | 0 | 0 |", base.finish_us as f64 / 1e6);
        for (attack, label) in [(Attack::Race { every: 64, lead_us: 5_000 }, "64 个复制一个，抢先 5 毫秒"), (Attack::Race { every: 8, lead_us: 5_000 }, "8 个复制一个"), (Attack::Race { every: 1, lead_us: 5_000 }, "每个都复制"), (Attack::Inject { every: 16 }, "每 16 个注入重放、篡改、随机包"), (Attack::Inject { every: 1 }, "每个都注入")] {
            let r = run_moves(&scenario(wifi(), wifi(), vec![], up, down, attack)); let (sv, _) = r.server.unwrap();
            println!("| {label} | {name} | {:.2} | {:.2} | {} / {} | {} | {} |", r.finish_us as f64 / 1e6, r.finish_us as f64 / base.finish_us as f64, r.attacker_sent, r.attacker_received, sv.path_challenges, sv.migrations);
        }
    }
    let (mut failed, mut moved, mut slowest) = (0, 0u64, 0u64);
    for seed in 0..2000 { let s = random_scenario(seed); let r = run_moves(&s); if !r.finished { failed += 1; } moved += r.server.map_or(0, |(sv, _)| sv.migrations); slowest = slowest.max(r.recoveries_us.iter().flatten().copied().max().unwrap_or(0)); }
    println!("\n随机矩阵 2000 个种子：未完成 {failed}，服务端换过去共 {moved} 次，最慢恢复 {:.1} 秒", slowest as f64 / 1e6);
}
