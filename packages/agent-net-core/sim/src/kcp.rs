//! 真实 KCP 的适配层，只在测试和对比里用，不进入产品。
//!
//! 对比时把官方资料里的配置都跑一遍，看 agent-net 和每一种单独比，也看每项指标和其中最好的值比。
//! 后者等于和一个“每个场景每项指标都挑了最合适配置”的 KCP 比，现实里不存在，所以结论要两边一起看。
//!
//! - KCP README：普通模式 `nodelay(0, 40, 0, 0)`、快速模式 `nodelay(1, 10, 2, 1)`、最小 RTO 降到 10 毫秒。
//! - KCP test.cpp：`nodelay(2, 10, 2, 1)` 加 `fastresend = 1` 和最小 RTO 10 毫秒，是官方代码里最激进的用法。
//! - KCP 最佳实践 wiki：FEC 放在 KCP 下面一层，还原出的包不要重复交给 KCP（见 `fec.rs`）。
//! - kcptun：fast `(0, 30, 2, 1)`、fast2 `(1, 20, 2, 1)`、fast3 `(1, 10, 2, 1)`，流模式，默认 FEC 10 + 3。
//!   数据写入就发，确认按节拍发（`acknodelay` 默认关）。校验占比要高过丢包率，丢 30% 时用 5 + 5。
//!   这些预设随版本变过，老版本的 fast 是 `(0, 40, 2, 1)`；2026-10 上游仓库访问不到，数值取自 fork 的
//!   `client/main.go` 和社区资料。三档的节拍 10、20、30 毫秒都覆盖到了。kcptun 实际跑在 kcp-go 上，
//!   这里用 C 版 KCP 加同样参数模拟，行为接近但不完全相同。
//! - 额外给 KCP 一档官方没有、但对它更有利的用法：收包后也立刻冲刷，不等节拍。

use std::ffi::{c_char, c_int, c_long, c_void};

use crate::Peer;
use crate::fec::{self, Fec};

#[repr(C)]
struct Kcp {
    _private: [u8; 0],
}

type Output = unsafe extern "C" fn(*const c_char, c_int, *mut Kcp, *mut c_void) -> c_int;

unsafe extern "C" {
    fn ikcp_create(conv: u32, user: *mut c_void) -> *mut Kcp;
    fn ikcp_release(kcp: *mut Kcp);
    fn ikcp_setoutput(kcp: *mut Kcp, output: Output);
    fn ikcp_recv(kcp: *mut Kcp, buffer: *mut c_char, len: c_int) -> c_int;
    fn ikcp_send(kcp: *mut Kcp, buffer: *const c_char, len: c_int) -> c_int;
    fn ikcp_update(kcp: *mut Kcp, current: u32);
    fn ikcp_check(kcp: *const Kcp, current: u32) -> u32;
    fn ikcp_input(kcp: *mut Kcp, data: *const c_char, size: c_long) -> c_int;
    fn ikcp_flush(kcp: *mut Kcp);
    fn ikcp_waitsnd(kcp: *const Kcp) -> c_int;
    fn ikcp_setmtu(kcp: *mut Kcp, mtu: c_int) -> c_int;
    fn ikcp_wndsize(kcp: *mut Kcp, sndwnd: c_int, rcvwnd: c_int) -> c_int;
    fn ikcp_nodelay(kcp: *mut Kcp, nodelay: c_int, interval: c_int, resend: c_int, nc: c_int) -> c_int;
    fn agent_net_kcp_tune(kcp: *mut Kcp, min_rto: c_int, stream: c_int);
}

/// KCP 的一种配置。
#[derive(Clone, Copy, Debug)]
pub struct KcpVariant {
    pub label: &'static str,
    /// `ikcp_nodelay` 的四个参数。
    nodelay: i32,
    interval: i32,
    resend: i32,
    nc: i32,
    /// 0 表示保持 `ikcp_nodelay` 设的默认值。
    min_rto: i32,
    stream: bool,
    flush_on_write: bool,
    flush_on_input: bool,
    /// Reed-Solomon 的数据片和校验片数量。
    fec: Option<(usize, usize)>,
}

impl KcpVariant {
    const README_FAST: KcpVariant = KcpVariant {
        label: "KCP 快速",
        nodelay: 1,
        interval: 10,
        resend: 2,
        nc: 1,
        min_rto: 0,
        stream: false,
        flush_on_write: false,
        flush_on_input: false,
        fec: None,
    };
    const README_NORMAL: KcpVariant = KcpVariant { label: "KCP 普通", nodelay: 0, interval: 40, resend: 0, nc: 0, ..Self::README_FAST };
    const FLUSH: KcpVariant = KcpVariant { label: "KCP 冲刷", flush_on_write: true, flush_on_input: true, ..Self::README_FAST };
    const TUNED: KcpVariant = KcpVariant { label: "KCP 调优", min_rto: 10, stream: true, ..Self::FLUSH };
    const TURBO: KcpVariant = KcpVariant { label: "KCP 极速", nodelay: 2, resend: 1, ..Self::TUNED };
    pub const TUNED_FEC: KcpVariant = KcpVariant { label: "调优+FEC", fec: Some((10, 3)), ..Self::TUNED };
    const TURBO_FEC: KcpVariant = KcpVariant { label: "极速+FEC", fec: Some((10, 3)), ..Self::TURBO };
    pub const TURBO_HEAVY_FEC: KcpVariant = KcpVariant { label: "极速+FEC5/5", fec: Some((5, 5)), ..Self::TURBO };
    const KCPTUN_FAST: KcpVariant = KcpVariant {
        label: "kcptun fast",
        nodelay: 0,
        interval: 30,
        stream: true,
        flush_on_write: true,
        fec: Some((10, 3)),
        ..Self::README_FAST
    };
    const KCPTUN_FAST2: KcpVariant = KcpVariant { label: "kcptun fast2", nodelay: 1, interval: 20, ..Self::KCPTUN_FAST };
    const KCPTUN_FAST3: KcpVariant = KcpVariant { label: "kcptun fast3", nodelay: 1, interval: 10, ..Self::KCPTUN_FAST };
    const KCPTUN_HEAVY: KcpVariant = KcpVariant { label: "kcptun fast3 5/5", fec: Some((5, 5)), ..Self::KCPTUN_FAST3 };

    pub const ALL: [KcpVariant; 12] = [
        Self::README_NORMAL,
        Self::README_FAST,
        Self::FLUSH,
        Self::TUNED,
        Self::TURBO,
        Self::KCPTUN_FAST,
        Self::KCPTUN_FAST2,
        Self::KCPTUN_FAST3,
        Self::KCPTUN_HEAVY,
        Self::TUNED_FEC,
        Self::TURBO_FEC,
        Self::TURBO_HEAVY_FEC,
    ];
}

unsafe extern "C" fn collect(buffer: *const c_char, len: c_int, _: *mut Kcp, user: *mut c_void) -> c_int {
    // SAFETY: `user` 是 ikcp_create 时传入的 Vec 指针，存活到 ikcp_release；buffer 由 KCP 保证有 len 字节。
    unsafe {
        let queue = &mut *(user as *mut Vec<Vec<u8>>);
        queue.push(std::slice::from_raw_parts(buffer as *const u8, len as usize).to_vec());
    }
    0
}

pub struct KcpPeer {
    kcp: *mut Kcp,
    queue: Box<Vec<Vec<u8>>>,
    window: i32,
    mss: usize,
    flush_on_write: bool,
    flush_on_input: bool,
    pending: Vec<u8>,
    pending_offset: usize,
    started: bool,
    now_ms: u32,
    fec: Option<Fec>,
    scratch: Vec<Vec<u8>>,
}

impl KcpPeer {
    pub fn new(flush_eagerly: bool) -> Self {
        Self::with_window(flush_eagerly, 128)
    }

    pub fn with_window(flush_eagerly: bool, window: i32) -> Self {
        Self::variant(if flush_eagerly { KcpVariant::FLUSH } else { KcpVariant::README_FAST }, window)
    }

    pub fn variant(variant: KcpVariant, window: i32) -> Self {
        // kcp-go 会从 MTU 里扣掉 FEC 头，保证加头之后的包仍不超过 1400 字节。
        let mtu = if variant.fec.is_some() { 1400 - fec::DATA_HEADER_LEN } else { 1400 };
        let mut queue = Box::new(Vec::new());
        let user = (&mut *queue) as *mut Vec<Vec<u8>> as *mut c_void;
        // SAFETY: queue 被 Box 固定在堆上，与 kcp 同生命周期。
        let kcp = unsafe {
            let kcp = ikcp_create(1, user);
            ikcp_setoutput(kcp, collect);
            ikcp_setmtu(kcp, mtu as c_int);
            ikcp_wndsize(kcp, window, window);
            ikcp_nodelay(kcp, variant.nodelay, variant.interval, variant.resend, variant.nc);
            agent_net_kcp_tune(kcp, variant.min_rto, variant.stream as c_int);
            kcp
        };
        Self {
            kcp,
            queue,
            window,
            mss: mtu - 24,
            flush_on_write: variant.flush_on_write,
            flush_on_input: variant.flush_on_input,
            pending: vec![0; 256 * 1024],
            pending_offset: 0,
            started: false,
            now_ms: 0,
            fec: variant.fec.map(|(data, parity)| Fec::new(data, parity)),
            scratch: Vec::new(),
        }
    }
}

impl Drop for KcpPeer {
    fn drop(&mut self) {
        // SAFETY: kcp 由 ikcp_create 创建，只释放一次。
        unsafe { ikcp_release(self.kcp) };
    }
}

fn ms(now_us: u64) -> u32 {
    (now_us / 1000) as u32
}

impl Peer for KcpPeer {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize {
        let mut written = 0;
        // SAFETY: 所有指针都指向存活的缓冲，长度不超过切片长度。
        unsafe {
            while written < data.len() && ikcp_waitsnd(self.kcp) < 2 * self.window {
                let size = (data.len() - written).min(self.mss);
                if ikcp_send(self.kcp, data[written..].as_ptr() as *const c_char, size as c_int) < 0 {
                    break;
                }
                written += size;
            }
            if self.flush_on_write && self.started && written > 0 {
                ikcp_update(self.kcp, ms(now_us));
                ikcp_flush(self.kcp);
            }
        }
        written
    }
    fn read(&mut self, _: u64, out: &mut [u8]) -> usize {
        if self.pending_offset == 0 {
            // SAFETY: pending 长度足够容纳单条消息，KCP 按缓冲长度截断检查。
            let size = unsafe { ikcp_recv(self.kcp, self.pending.as_mut_ptr() as *mut c_char, self.pending.len() as c_int) };
            if size <= 0 {
                return 0;
            }
            self.pending.truncate(size as usize);
        }
        let take = (self.pending.len() - self.pending_offset).min(out.len());
        out[..take].copy_from_slice(&self.pending[self.pending_offset..self.pending_offset + take]);
        self.pending_offset += take;
        if self.pending_offset == self.pending.len() {
            self.pending_offset = 0;
            self.pending.resize(256 * 1024, 0);
        }
        take
    }
    fn input(&mut self, now_us: u64, packet: &[u8]) {
        self.now_ms = ms(now_us);
        // SAFETY: 交给 ikcp_input 的切片在调用期间有效。
        unsafe {
            match &mut self.fec {
                Some(fec) => {
                    let mut decoded = core::mem::take(&mut self.scratch);
                    fec.decode(packet, &mut decoded);
                    for packet in decoded.drain(..) {
                        ikcp_input(self.kcp, packet.as_ptr() as *const c_char, packet.len() as c_long);
                    }
                    self.scratch = decoded;
                }
                None => {
                    ikcp_input(self.kcp, packet.as_ptr() as *const c_char, packet.len() as c_long);
                }
            }
            if self.flush_on_input && self.started {
                ikcp_update(self.kcp, ms(now_us));
                ikcp_flush(self.kcp);
            }
        }
    }
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8])) {
        self.now_ms = ms(now_us);
        if !self.started {
            self.started = true;
            // SAFETY: kcp 有效。
            unsafe { ikcp_update(self.kcp, ms(now_us)) };
        }
        let mut encoded = core::mem::take(&mut self.scratch);
        for packet in self.queue.drain(..) {
            match &mut self.fec {
                Some(fec) => {
                    fec.encode(&packet, &mut encoded);
                    for packet in encoded.drain(..) {
                        sink(&packet);
                    }
                }
                None => sink(&packet),
            }
        }
        self.scratch = encoded;
    }
    fn wake_at(&self) -> Option<u64> {
        if !self.started {
            return Some(0);
        }
        Some(self.next_check())
    }
    fn on_wake(&mut self, now_us: u64) {
        self.now_ms = ms(now_us);
        // SAFETY: kcp 有效。
        unsafe { ikcp_update(self.kcp, ms(now_us)) };
    }
    fn buffered(&self) -> usize {
        0
    }
    fn is_dead(&self) -> bool {
        false
    }
}

impl KcpPeer {
    fn next_check(&self) -> u64 {
        // SAFETY: kcp 有效，ikcp_check 只读。
        let at = unsafe { ikcp_check(self.kcp, self.now_ms) };
        at as u64 * 1000
    }
}
