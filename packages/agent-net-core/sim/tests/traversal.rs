//! 测试价值
//! - 生产入口与可观察结果：核心的 `Endpoint`（`connect` / `listen` / `probe` / `on_datagram` / `poll_transmit` / `tick`）带上
//!   有代价的地址（`PathAddress`：中继 1、UDP 0），两端各在一个 NAT 后面，先经中继连上，再同时验证对方的公网地址。
//!   断言最后的数据路径是直连还是中继、两个方向的数据完整、在中继和直连之间换了几次、打洞失败时白发了多少字节。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 7 步（打洞和中继，UDP 全封时能走 443）。写随机矩阵时查出：
//!   换到直连后往返从头量，长往返路径上第一次超时是误判，原来一次超时就退回中继、马上又换回直连（种子 195），
//!   现在连续两次超时才算断，有包在途、确认照常回来时也不跟着对端从中继来的包回去。
//! - 现有覆盖缺口：`migration.rs` 只测跟着对端换地址，没有路径代价、主动验证和退回备用路径；`udp.rs` 只在本机回环上，没有 NAT。
//! - 最小失败输入：NAT 组合表、两个换网用例写在用例里；随机矩阵打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放。
//! - tier：Rust integration，确定性模拟器，虚拟时钟，不碰网络。
//! - 实测耗时：2026-11-05，Windows 本机（不含编译），整个文件约 4 秒：随机矩阵默认 30 个种子；`AGENT_NET_SEEDS=1000` 约 110 秒。

use agent_net_sim::traversal::{Change, Nat, Report, Scenario, SimAddr, run, scenario};
use agent_net_sim::{LinkProfile, Rng};

const MIB: u64 = 1 << 20;
/// 每一轮验证，每个候选地址最多 4 个满长度的验证包。
const PROBES_PER_ROUND: u64 = 4;

fn describe(report: &Report) -> String {
    let sides: Vec<String> = report
        .sides
        .iter()
        .map(|side| {
            format!(
                "direct={} switches={:?} relay={}K direct={}K unanswered={}K probes={} fallbacks={}",
                side.direct_at_end,
                side.switch_times.iter().map(|at| at / 1000).collect::<Vec<_>>(),
                side.relay_bytes / 1024,
                side.direct_bytes / 1024,
                side.unanswered_bytes / 1024,
                side.security.path_probes,
                side.security.fallback_probes
            )
        })
        .collect();
    format!(
        "finished={} at {}ms direct_after={:?} recoveries={:?} violation={:?} spurious={} | A {} | B {}",
        report.finished,
        report.finish_us / 1000,
        report.direct_after_us.map(|at| at / 1000),
        report.recoveries_us,
        report.violation,
        report.spurious_wakes,
        sides[0],
        sides[1]
    )
}

/// 白发的字节不超过每轮每个候选地址 4 个满长度的包，再加一轮：对端从没见过的地址来时（对称型 NAT 给的新端口），
/// 这一端跟着去验证那里，第一个验证包发出时那里还没有包到过。
fn wasted_bounded(case: &Scenario, report: &Report) -> bool {
    let rounds = 1 + report.finish_us.checked_div(case.reprobe_us).unwrap_or(0);
    let candidates = 1 + case.same_lan as u64;
    let limit = (rounds * candidates + 1) * PROBES_PER_ROUND * case.config.max_packet_size as u64;
    report.sides.iter().all(|side| side.unanswered_bytes <= limit)
}

/// 按 RFC 4787 的映射和过滤行为，哪些组合打得通：端口受限锥形对端口受限锥形靠两边同时发包打通；
/// 对称型一端只有对端是全锥形或受限锥形（只按 IP 过滤）时打得通，对端看到的是它真正用的端口；
/// 对称型对端口受限锥形、对称型对对称型、UDP 被挡都只能走中继。
#[test]
fn nat_combinations_punch_through_or_stay_on_relay() {
    let cases = [
        ([Nat::Open, Nat::Open], true),
        ([Nat::FullCone, Nat::PortRestricted], true),
        ([Nat::Restricted, Nat::Restricted], true),
        ([Nat::PortRestricted, Nat::PortRestricted], true),
        ([Nat::Symmetric, Nat::FullCone], true),
        ([Nat::Symmetric, Nat::Restricted], true),
        ([Nat::Symmetric, Nat::PortRestricted], false),
        ([Nat::Symmetric, Nat::Symmetric], false),
        ([Nat::UdpBlocked, Nat::Open], false),
    ];
    for (nats, punches) in cases {
        let case = scenario(1, nats, 15_000, 20_000, [4 * MIB, 4 * MIB]);
        let report = run(&case);
        let label = format!("{nats:?}: {}", describe(&report));
        assert!(report.finished && report.spurious_wakes == 0, "{label}");
        assert!(wasted_bounded(&case, &report), "{label}");
        for side in &report.sides {
            assert_eq!(side.direct_at_end, punches, "{label}");
            // 打通了只换一次，不来回；打不通就一次都不换。
            assert_eq!(side.switches, punches as u32, "{label}");
            if punches {
                // 2026-11-07：第一份交号可能还在中继队列里，打洞先走、缺号单独计数；有备用号就不复用。
                let mut seen = std::collections::BTreeSet::new();
                let mut reused = 0;
                for ids in side.connection_ids.values() {
                    reused += seen.intersection(ids).count();
                    seen.extend(ids);
                }
                assert!(reused as u64 <= side.security.connection_id_exhaustions, "unreported id reuse: {label}");
                // 握手和换路径之前的那一两百毫秒走中继；对称型一端要多等对端跟过来的一个往返，约 6%。
                assert!(side.relay_bytes * 10 < side.relay_bytes + side.direct_bytes, "{label}: more than 10% went over the relay");
            }
        }
        if punches {
            // 交换地址要一个中继往返，验证一个直连往返，这里是 70 + 30 毫秒；对称型一端多等对端跟过来的一个往返。
            assert!(report.direct_after_us.is_some_and(|at| at <= 150_000), "{label}");
        }
    }
}

/// 第 7 步的过关标准在模拟里的对应：两端的 UDP 都被挡，所有数据走中继（产品里是 443 上的 WebSocket），一个 UDP 包都不发。
#[test]
fn udp_blocked_on_both_sides_carries_everything_over_the_relay() {
    let report = run(&scenario(2, [Nat::UdpBlocked, Nat::UdpBlocked], 15_000, 20_000, [4 * MIB, 4 * MIB]));
    let label = describe(&report);
    assert!(report.finished && report.spurious_wakes == 0, "{label}");
    for side in &report.sides {
        assert_eq!((side.direct_bytes, side.switches, side.direct_at_end), (0, 0, false), "{label}");
    }
}

/// 两端在同一个局域网、公网地址又打不通时，走本机地址直达。
#[test]
fn same_lan_goes_direct_over_the_local_address() {
    let mut case = scenario(3, [Nat::Symmetric, Nat::Symmetric], 1_000, 30_000, [4 * MIB, 4 * MIB]);
    case.same_lan = true;
    let report = run(&case);
    let label = describe(&report);
    assert!(report.finished && report.spurious_wakes == 0 && wasted_bounded(&case, &report), "{label}");
    assert!(report.sides.iter().all(|side| side.direct_at_end && side.switches == 1), "{label}");
}

/// 直连中途断了（一端的 UDP 被挡）：连续两次超时后退回中继，数据接着走；恢复以后下一轮验证再换回直连。
/// 每一端正好换三次：打通、退回、再打通。
#[test]
fn a_dead_direct_path_falls_back_to_the_relay_and_comes_back() {
    let mut case = scenario(4, [Nat::PortRestricted, Nat::PortRestricted], 15_000, 20_000, [32 * MIB, 32 * MIB]);
    case.changes = vec![Change { at_us: 3_000_000, side: 1, nat: Nat::UdpBlocked }, Change { at_us: 6_000_000, side: 1, nat: Nat::PortRestricted }];
    let report = run(&case);
    let label = describe(&report);
    assert!(report.finished && report.spurious_wakes == 0 && wasted_bounded(&case, &report), "{label}");
    assert!(report.recoveries_us.first().copied().flatten().is_some_and(|at| at <= 500_000), "{label}");
    for side in &report.sides {
        assert!(side.direct_at_end && side.switches == 3 && side.security.fallback_probes == 1, "{label}");
        assert!(side.security.connection_ids_retired >= 2 && side.security.connection_id_rotations >= 3, "{label}");
        let relay = side.connection_ids.get(&SimAddr::Relay).expect("relay ids");
        let overlap: usize = side.connection_ids.iter().filter(|(path, _)| **path != SimAddr::Relay).map(|(_, ids)| relay.intersection(ids).count()).sum();
        assert!(overlap as u64 <= side.security.connection_id_exhaustions, "unreported relay/direct id overlap: {label}");
    }
}

fn random_scenario(seed: u64) -> Scenario {
    let mut rng = Rng::new(seed ^ 0x7A5E_0001);
    let kinds = [Nat::Open, Nat::FullCone, Nat::Restricted, Nat::PortRestricted, Nat::PortRestricted, Nat::Symmetric, Nat::UdpBlocked];
    let nats = [rng.pick(&kinds), rng.pick(&kinds)];
    let delay = 1_000 + rng.below(150_000);
    let loss = if rng.chance(0.3) { 0.0 } else { rng.below(60) as f64 / 1000.0 };
    let direct = LinkProfile {
        bits_per_second: 2_000_000 + rng.below(98_000_000),
        delay_us: delay,
        jitter_us: rng.below(20_000),
        loss,
        queue_us: 20_000 + rng.below(200_000),
        ..LinkProfile::default()
    };
    let relay = LinkProfile { bits_per_second: 2_000_000 + rng.below(48_000_000), delay_us: delay + rng.below(100_000), jitter_us: rng.below(5_000), queue_us: 2_000_000, ..LinkProfile::default() };
    let mut case = scenario(seed, nats, delay, 0, [rng.below(6 * MIB), rng.below(6 * MIB) + 1]);
    case.direct = [direct.clone(), direct];
    case.relay = [relay.clone(), relay];
    case.same_lan = rng.chance(0.1);
    case.mapping_timeout_us = 5_000_000 + rng.below(55_000_000);
    case.reprobe_us = if rng.chance(0.2) { 0 } else { 2_000_000 + rng.below(13_000_000) };
    let mut at = 0;
    for _ in 0..rng.below(3) {
        at += 500_000 + rng.below(15_000_000);
        let side = rng.below(2) as usize;
        let nat = if rng.chance(0.5) { Nat::UdpBlocked } else { nats[side] };
        case.changes.push(Change { at_us: at, side, nat });
    }
    case.time_limit_us = 900_000_000;
    case
}

/// 两次换路径挨得太近（1 秒内）、之间又没有网络变化，就是在来回跳。
fn flaps(case: &Scenario, report: &Report) -> bool {
    report.sides.iter().any(|side| {
        side.switch_times.windows(2).any(|pair| pair[1] - pair[0] < 1_000_000 && !case.changes.iter().any(|change| change.at_us + 2_000_000 >= pair[0] && change.at_us <= pair[1]))
    })
}

/// 随机 NAT 组合、直连丢包和抖动、映射过期、同一局域网、上层重试间隔，加上随机的直连断开和恢复：
/// 都要传完、数据完整、端点不空转、不来回跳，打洞白发的字节有上限。
#[test]
fn random_paths_and_changes_deliver_without_flapping() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => (0..std::env::var("AGENT_NET_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(30)).collect(),
    };
    let mut failures = Vec::new();
    for seed in seeds {
        let case = random_scenario(seed);
        let report = run(&case);
        if !report.finished || report.spurious_wakes > 0 || flaps(&case, &report) || !wasted_bounded(&case, &report) {
            failures.push(format!("seed {seed}: {}\n  nats={:?} lan={} changes={:?}", describe(&report), case.nats, case.same_lan, case.changes));
            if failures.len() == 5 {
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} failing seeds:\n{}", failures.len(), failures.join("\n"));
}
