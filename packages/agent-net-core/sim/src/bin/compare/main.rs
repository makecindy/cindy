//! 同一网络条件下对比自研核心和真实 KCP。KCP 只在这里出现，不进入产品。
//! 运行：`./fetch-kcp.sh && cargo run --release -p agent-net-sim --features kcp --bin compare`

fn main() {
    #[cfg(not(feature = "kcp"))]
    println!("需要真实 KCP：先运行 ./fetch-kcp.sh，再加 --features kcp。");
    #[cfg(feature = "kcp")]
    report::main();
}

#[cfg(feature = "kcp")]
mod report;
