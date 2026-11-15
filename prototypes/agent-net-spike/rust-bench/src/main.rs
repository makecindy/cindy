//! agent-net 第 0 阶段原生基准。绕开 Node 绑定的数组转换，测 QUIC 本身的能力。
//!
//! server <bind>                                 打印身份和地址后等待连接
//! client <id> <addr> <bulkMiB>                  输出 JSON 基准结果
//! shape-udp|shape-tcp <listen> <target> <Mbit/s> <单向ms> <队列ms>  模拟瓶颈链路
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use iroh::endpoint::transports::{PathSelection, PathSelectionContext, PathSelector};
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, TransportAddr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Mutex;
use tokio::time::{Instant as TokioInstant, sleep, sleep_until};

const ALPN: &[u8] = b"cindy/agent-net/0";
const CHUNK: usize = 256 * 1024;

/// 固定在第一条路径上。否则 iroh 会自动找到更优路径，绕过模拟瓶颈，测不到链路本身。
#[derive(Debug)]
struct StickyPath;

impl PathSelector for StickyPath {
    fn select(&self, context: &PathSelectionContext<'_>) -> PathSelection {
        let mut selection = PathSelection::none();
        if context.current().is_none() {
            if let Some(path) = context.paths().next() {
                selection.set(&path);
            }
        }
        selection
    }
}

async fn bind(addr: &str) -> Result<Endpoint> {
    let socket = SocketAddr::from_str(addr)?;
    let mut builder = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind_addr(socket)?;
    if std::env::var_os("STICKY_PATH").is_some() {
        builder = builder.path_selector(Arc::new(StickyPath));
    }
    let endpoint = builder
        .bind()
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(endpoint)
}

async fn serve_stream(mut send: SendStream, mut recv: RecvStream) -> Result<()> {
    let mut mode = [0u8; 1];
    recv.read_exact(&mut mode).await?;
    if mode[0] == b'E' {
        let mut body = [0u8; 64];
        loop {
            if recv.read_exact(&mut body).await.is_err() {
                return Ok(());
            }
            send.write_all(&body).await?;
        }
    }
    let mut buffer = vec![0u8; CHUNK];
    let mut total = 0u64;
    while let Some(read) = recv.read(&mut buffer).await? {
        total += read as u64;
    }
    send.write_all(&total.to_be_bytes()).await?;
    send.finish()?;
    Ok(())
}

async fn serve(connection: Connection) {
    while let Ok((send, recv)) = connection.accept_bi().await {
        tokio::spawn(serve_stream(send, recv));
    }
}

async fn run_server(addr: &str) -> Result<()> {
    let endpoint = bind(addr).await?;
    let sockets: Vec<String> = endpoint.bound_sockets().iter().map(|s| s.to_string()).collect();
    println!("{{\"id\":\"{}\",\"sockets\":{:?}}}", endpoint.id(), sockets);
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            if let Ok(accepting) = incoming.accept() {
                if let Ok(connection) = accepting.await {
                    serve(connection).await;
                }
            }
        });
    }
    Ok(())
}

fn summary(samples: &mut [f64]) -> String {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if samples.is_empty() {
        return "null".into();
    }
    let pick = |p: f64| samples[((p * samples.len() as f64).ceil() as usize).saturating_sub(1)];
    format!(
        "{{\"n\":{},\"p50\":{:.2},\"p95\":{:.2},\"max\":{:.2}}}",
        samples.len(),
        pick(0.5),
        pick(0.95),
        samples[samples.len() - 1]
    )
}

async fn ping(send: &mut SendStream, recv: &mut RecvStream, body: &[u8; 64]) -> Result<f64> {
    let start = Instant::now();
    let mut reply = [0u8; 64];
    send.write_all(body).await?;
    recv.read_exact(&mut reply).await?;
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

async fn bulk(connection: &Connection, total: usize) -> Result<(f64, u64)> {
    let (mut send, mut recv) = connection.open_bi().await?;
    send.write_all(b"S").await?;
    let chunk = vec![7u8; CHUNK];
    let start = Instant::now();
    let mut sent = 0;
    while sent < total {
        send.write_all(&chunk).await?;
        sent += CHUNK;
    }
    send.finish()?;
    let mut reply = [0u8; 8];
    recv.read_exact(&mut reply).await?;
    Ok((start.elapsed().as_secs_f64() * 1000.0, u64::from_be_bytes(reply)))
}

async fn run_client(id: &str, addr: &str, bulk_mib: usize) -> Result<()> {
    let endpoint = bind(if addr.starts_with("127.") { "127.0.0.1:0" } else { "0.0.0.0:0" }).await?;
    let id = EndpointId::from_str(id).context("endpoint id")?;
    let target = EndpointAddr::from_parts(id, [TransportAddr::Ip(SocketAddr::from_str(addr)?)]);
    let total = bulk_mib * 1024 * 1024;

    let mut connects = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let connection = endpoint.connect(target.clone(), ALPN).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        connects.push(start.elapsed().as_secs_f64() * 1000.0);
        connection.close(0u32.into(), b"");
        sleep(Duration::from_millis(20)).await;
    }

    let connection = endpoint.connect(target.clone(), ALPN).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let (mut send, mut recv) = connection.open_bi().await?;
    send.write_all(b"E").await?;
    send.set_priority(10)?;
    let body = [1u8; 64];
    let mut rtts = Vec::new();
    for _ in 0..200 {
        rtts.push(ping(&mut send, &mut recv, &body).await?);
    }

    let (alone_ms, alone_bytes) = bulk(&connection, total).await?;

    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    let loaded_connection = connection.clone();
    let loaded = tokio::spawn(async move {
        let result = bulk(&loaded_connection, total).await;
        flag.store(true, Ordering::SeqCst);
        result
    });
    let mut under_load = Vec::new();
    while !done.load(Ordering::SeqCst) {
        under_load.push(ping(&mut send, &mut recv, &body).await?);
        sleep(Duration::from_millis(20)).await;
    }
    let (loaded_ms, loaded_bytes) = loaded.await??;

    let rate = |ms: f64| (total as f64 / 1048576.0) / (ms / 1000.0);
    println!(
        "{{\"transport\":\"quic-native\",\"bulkMiB\":{},\"connectMs\":{},\"rttMs\":{},\"throughputMiBs\":{:.1},\"rttUnderLoadMs\":{},\"throughputWithPingMiBs\":{:.1},\"integrity\":{}}}",
        bulk_mib,
        summary(&mut connects),
        summary(&mut rtts),
        rate(alone_ms),
        summary(&mut under_load),
        rate(loaded_ms),
        alone_bytes == total as u64 && loaded_bytes == total as u64
    );
    connection.close(0u32.into(), b"");
    endpoint.close().await;
    Ok(())
}

/// 单向瓶颈：按带宽排队、加固定时延；队列超过上限时由调用方决定丢包或停读。
struct Link {
    bytes_per_ms: f64,
    delay: Duration,
    queue_limit: Duration,
    next_free: TokioInstant,
}

impl Link {
    fn new(mbit: f64, one_way_ms: u64, queue_ms: u64) -> Self {
        Self {
            bytes_per_ms: mbit * 1_000_000.0 / 8.0 / 1000.0,
            delay: Duration::from_millis(one_way_ms),
            queue_limit: Duration::from_millis(queue_ms),
            next_free: TokioInstant::now(),
        }
    }
    fn backlog(&self) -> Duration {
        self.next_free.saturating_duration_since(TokioInstant::now())
    }
    fn schedule(&mut self, bytes: usize) -> TokioInstant {
        let start = self.next_free.max(TokioInstant::now());
        self.next_free = start + Duration::from_secs_f64(bytes as f64 / self.bytes_per_ms / 1000.0);
        self.next_free + self.delay
    }
}

type Pipe<T> = Arc<Mutex<VecDeque<(TokioInstant, T)>>>;

async fn deliver_udp(queue: Pipe<Vec<u8>>, socket: Arc<UdpSocket>, peer: Arc<Mutex<Option<SocketAddr>>>) {
    loop {
        let next = queue.lock().await.front().map(|(at, _)| *at);
        let Some(at) = next else {
            sleep(Duration::from_micros(200)).await;
            continue;
        };
        sleep_until(at).await;
        let Some((_, packet)) = queue.lock().await.pop_front() else { continue };
        if let Some(addr) = *peer.lock().await {
            let _ = socket.send_to(&packet, addr).await;
        }
    }
}

async fn shape_udp(listen: &str, target: &str, mbit: f64, one_way_ms: u64, queue_ms: u64) -> Result<()> {
    let front = Arc::new(UdpSocket::bind(listen).await?);
    let back = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let target: SocketAddr = target.parse()?;
    let client = Arc::new(Mutex::new(None));
    let server = Arc::new(Mutex::new(Some(target)));
    let up: Pipe<Vec<u8>> = Arc::new(Mutex::new(VecDeque::new()));
    let down: Pipe<Vec<u8>> = Arc::new(Mutex::new(VecDeque::new()));
    tokio::spawn(deliver_udp(up.clone(), back.clone(), server));
    tokio::spawn(deliver_udp(down.clone(), front.clone(), client.clone()));
    let mut up_link = Link::new(mbit, one_way_ms, queue_ms);
    let mut down_link = Link::new(mbit, one_way_ms, queue_ms);
    let mut a = vec![0u8; 65536];
    let mut b = vec![0u8; 65536];
    loop {
        tokio::select! {
            read = front.recv_from(&mut a) => {
                let (size, from) = read?;
                *client.lock().await = Some(from);
                if up_link.backlog() <= up_link.queue_limit {
                    let at = up_link.schedule(size);
                    up.lock().await.push_back((at, a[..size].to_vec()));
                }
            }
            read = back.recv_from(&mut b) => {
                let (size, _) = read?;
                if down_link.backlog() <= down_link.queue_limit {
                    let at = down_link.schedule(size);
                    down.lock().await.push_back((at, b[..size].to_vec()));
                }
            }
        }
    }
}

async fn pump_tcp(mut from: tokio::net::tcp::OwnedReadHalf, mut to: tokio::net::tcp::OwnedWriteHalf, mbit: f64, one_way_ms: u64, queue_ms: u64) {
    let queue: Pipe<Vec<u8>> = Arc::new(Mutex::new(VecDeque::new()));
    let writer = queue.clone();
    tokio::spawn(async move {
        loop {
            let next = writer.lock().await.front().map(|(at, _)| *at);
            let Some(at) = next else {
                sleep(Duration::from_micros(200)).await;
                continue;
            };
            sleep_until(at).await;
            let Some((_, chunk)) = writer.lock().await.pop_front() else { continue };
            if to.write_all(&chunk).await.is_err() {
                return;
            }
        }
    });
    let mut link = Link::new(mbit, one_way_ms, queue_ms);
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        // TCP 不能在代理里丢包，队列满时停读，把压力退回发送端的 socket 缓冲。
        while link.backlog() > link.queue_limit {
            sleep(Duration::from_millis(1)).await;
        }
        let Ok(size) = from.read(&mut buffer).await else { return };
        if size == 0 {
            return;
        }
        let at = link.schedule(size);
        queue.lock().await.push_back((at, buffer[..size].to_vec()));
    }
}

async fn shape_tcp(listen: &str, target: &str, mbit: f64, one_way_ms: u64, queue_ms: u64) -> Result<()> {
    let listener = TcpListener::bind(listen).await?;
    println!("{{\"port\":{}}}", listener.local_addr()?.port());
    loop {
        let (client, _) = listener.accept().await?;
        client.set_nodelay(true)?;
        let upstream = TcpStream::connect(target).await?;
        upstream.set_nodelay(true)?;
        let (client_read, client_write) = client.into_split();
        let (server_read, server_write) = upstream.into_split();
        tokio::spawn(pump_tcp(client_read, server_write, mbit, one_way_ms, queue_ms));
        tokio::spawn(pump_tcp(server_read, client_write, mbit, one_way_ms, queue_ms));
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("server") => run_server(&args[2]).await,
        Some("client") => run_client(&args[2], &args[3], args[4].parse()?).await,
        Some("shape-udp") => shape_udp(&args[2], &args[3], args[4].parse()?, args[5].parse()?, args[6].parse()?).await,
        Some("shape-tcp") => shape_tcp(&args[2], &args[3], args[4].parse()?, args[5].parse()?, args[6].parse()?).await,
        _ => bail!("usage: server|client|shape-udp|shape-tcp"),
    }
}
