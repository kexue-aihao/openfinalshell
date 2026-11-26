//! lansync 的 Rust 实现：UDP 发现编解码 + TCP 帧编解码 + 增量拆帧器。
//!
//! 这一层**没有 async、没有 socket、没有 tokio**。socket 的生命周期仍然归
//! `src/main/lansync/LanSyncManager.ts` 与 `discovery.ts`，这里只做字节。

pub mod discovery;
pub mod js_json;
pub mod reader;
pub mod validate;

pub use ofs_contract::{DiscoveryAnnounce, DiscoveryMsg, DiscoveryProbe, FrameError, SyncFrame};

use ofs_contract::{MAGIC, SYNC_PROTO};

/// 与 TS `encodeDiscovery` 等价：`JSON.stringify(msg)` 的 UTF-8 字节，不做校验。
///
/// 调用方传进来的是 JS 对象经 napi 转成的 `Value`，键序已经是 JS 的枚举序；
/// `js_json` 再按同一套规则输出，于是字节与 `JSON.stringify` 一致。
pub fn encode_discovery_value(msg: &serde_json::Value) -> Vec<u8> {
    js_json::to_string(msg).into_bytes()
}

/// 与 TS `encodeFrame` 等价：4 字节大端长度前缀 + UTF-8 JSON，不做校验。
pub fn encode_frame_value(frame: &serde_json::Value) -> Vec<u8> {
    let body = js_json::to_string(frame).into_bytes();
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// 发现报文的 JSON 文本（给 `to_value()` 之外的地方用，比如测试断言）。
pub fn decode_discovery_text(text: &str) -> Option<DiscoveryMsg> {
    discovery::decode_bytes(text.as_bytes())
}

/// 自检用：常量必须与 TS 侧一致，改了一边就该在这里红。
pub fn protocol_fingerprint() -> String {
    format!("{MAGIC}/{SYNC_PROTO}")
}
