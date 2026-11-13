//! agent-net 自研传输核心。
//!
//! 不碰套接字和时钟：调用方把收到的包、当前时间喂进来，再取出要发的包。
//! 这样同一份代码能跑在桌面、手机和硬件上，也能在模拟器里精确复现任何故障。
//!
//! 一条连接里可以有多条流，按优先级发送、各自交付。[`SecureConnection`] 在此之上加了 Noise IK 握手、
//! 逐包认证加密和防重放；加密算法由调用方通过 [`Crypto`] 提供，核心不带任何算法实现。
//! [`Endpoint`] 把一个本地端口上的多条加密连接按连接号分发，各平台的驱动只管套接字和时钟。
//! 线上格式在接入产品之前不做兼容承诺。
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

mod admission;
mod congestion;
mod connection;
mod crypto;
mod endpoint;
mod ids;
pub mod noise;
mod parity;
mod rtt;
mod secure;
mod stream;
mod wire;

pub use admission::Admission;
pub use connection::{BandwidthShare, Config, Connection, PacketError, RecoveryPolicy, Stats};
pub use crypto::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};
pub use endpoint::{Endpoint, EndpointStats, PathAddress};
pub use noise::HandshakeError;
pub use secure::{Incoming, SecureConnection, SecurityStats, destination_id, is_cookie_reply, is_initiation, max_handshake_payload};
pub use stream::{DEFAULT_STREAM, Priority, StreamEvent};
