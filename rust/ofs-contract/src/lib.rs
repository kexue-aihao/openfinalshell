//! 跨语言线格式契约 —— 目前只有 lansync 这一片。
//!
//! 这里的每个常量与字段顺序都必须与 `src/main/lansync/protocol.ts` 逐字对应：
//! 字段顺序就是 zod object 的声明顺序，也就是 JSON 上的键序。TS 侧解码走 zod
//! （未知键 strip、`applied` 的四个字段有 `default(0)`），Rust 侧解码走
//! `ofs-lansync::validate`，两边产出同一个形状，因此这里不派生 serde
//! `Serialize`，而是手写 `to_value()` —— 顺序完全可控，不会被内部标签枚举的
//! 中间缓冲改写。
//!
//! 数字统一用 `f64`：zod 的 `.int()` 只要求 `Number.isInteger`，`1e20` 是合法
//! 的 `profiles` 计数，而 `1e20 > u64::MAX`。用整数类型会在这里制造一个只有
//! 大数才触发的分歧。

use serde_json::{Map, Value};

pub const SYNC_PROTO: i64 = 1;
pub const MAGIC: &str = "OFSSYNC1";
pub const DISCOVERY_PORT: u16 = 52133;
pub const DISCOVERY_GROUP: &str = "239.255.77.88";
pub const MAX_DATAGRAM_BYTES: usize = 1400;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const HANDSHAKE_MAX_FRAME_BYTES: usize = 64 * 1024;

/// `z.union([z.string().max(256), z.number()])` 的对应物。
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Text(String),
    Number(f64),
}

/// `error` 帧的参数表。zod 的 `z.record` 保持输入键序，所以这里也用有序表而不是 map。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ErrorParams(pub Vec<(String, ParamValue)>);

#[derive(Debug, Clone, PartialEq)]
pub enum SyncFrame {
    Hello {
        magic: String,
        proto: i64,
        device_id: String,
        device_name: String,
        app_version: String,
        sender_pub: String,
    },
    HelloAck {
        device_id: String,
        device_name: String,
        app_version: String,
        receiver_pub: String,
        salt: String,
        session_id: String,
    },
    ConfirmS {
        mac: String,
    },
    ConfirmR {
        mac: String,
    },
    Payload {
        envelope: String,
    },
    Received,
    Applied {
        profiles: f64,
        groups: f64,
        proxies: f64,
        private_keys: f64,
        ai_profiles: f64,
        snippets: f64,
        forwards: f64,
        known_hosts: f64,
        secrets: f64,
        skipped: f64,
    },
    Rejected,
    Error {
        code: String,
        params: Option<ErrorParams>,
    },
}

impl SyncFrame {
    /// 与 zod `safeParse().data` 完全同形的输出：键序 = 声明序，`applied` 的
    /// 四个可选计数恒定出现，`error.params` 缺省时整个键不出现。
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            SyncFrame::Hello {
                magic,
                proto,
                device_id,
                device_name,
                app_version,
                sender_pub,
            } => {
                map.insert("kind".into(), Value::String("hello".into()));
                map.insert("magic".into(), Value::String(magic.clone()));
                map.insert("proto".into(), json_number(*proto as f64));
                map.insert("deviceId".into(), Value::String(device_id.clone()));
                map.insert("deviceName".into(), Value::String(device_name.clone()));
                map.insert("appVersion".into(), Value::String(app_version.clone()));
                map.insert("senderPub".into(), Value::String(sender_pub.clone()));
            }
            SyncFrame::HelloAck {
                device_id,
                device_name,
                app_version,
                receiver_pub,
                salt,
                session_id,
            } => {
                map.insert("kind".into(), Value::String("hello-ack".into()));
                map.insert("deviceId".into(), Value::String(device_id.clone()));
                map.insert("deviceName".into(), Value::String(device_name.clone()));
                map.insert("appVersion".into(), Value::String(app_version.clone()));
                map.insert("receiverPub".into(), Value::String(receiver_pub.clone()));
                map.insert("salt".into(), Value::String(salt.clone()));
                map.insert("sessionId".into(), Value::String(session_id.clone()));
            }
            SyncFrame::ConfirmS { mac } => {
                map.insert("kind".into(), Value::String("confirm-s".into()));
                map.insert("mac".into(), Value::String(mac.clone()));
            }
            SyncFrame::ConfirmR { mac } => {
                map.insert("kind".into(), Value::String("confirm-r".into()));
                map.insert("mac".into(), Value::String(mac.clone()));
            }
            SyncFrame::Payload { envelope } => {
                map.insert("kind".into(), Value::String("payload".into()));
                map.insert("envelope".into(), Value::String(envelope.clone()));
            }
            SyncFrame::Received => {
                map.insert("kind".into(), Value::String("received".into()));
            }
            SyncFrame::Applied {
                profiles,
                groups,
                proxies,
                private_keys,
                ai_profiles,
                snippets,
                forwards,
                known_hosts,
                secrets,
                skipped,
            } => {
                map.insert("kind".into(), Value::String("applied".into()));
                map.insert("profiles".into(), json_number(*profiles));
                map.insert("groups".into(), json_number(*groups));
                map.insert("proxies".into(), json_number(*proxies));
                map.insert("privateKeys".into(), json_number(*private_keys));
                map.insert("aiProfiles".into(), json_number(*ai_profiles));
                map.insert("snippets".into(), json_number(*snippets));
                map.insert("forwards".into(), json_number(*forwards));
                map.insert("knownHosts".into(), json_number(*known_hosts));
                map.insert("secrets".into(), json_number(*secrets));
                map.insert("skipped".into(), json_number(*skipped));
            }
            SyncFrame::Rejected => {
                map.insert("kind".into(), Value::String("rejected".into()));
            }
            SyncFrame::Error { code, params } => {
                map.insert("kind".into(), Value::String("error".into()));
                map.insert("code".into(), Value::String(code.clone()));
                if let Some(params) = params {
                    let mut record = Map::new();
                    for (key, value) in &params.0 {
                        record.insert(
                            key.clone(),
                            match value {
                                ParamValue::Text(text) => Value::String(text.clone()),
                                ParamValue::Number(number) => json_number(*number),
                            },
                        );
                    }
                    map.insert("params".into(), Value::Object(record));
                }
            }
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveryProbe {
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveryAnnounce {
    pub device_id: String,
    pub device_name: String,
    pub app_version: String,
    /// 1..=65535，zod 已保证范围内。
    pub tcp_port: u16,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveryMsg {
    Probe(DiscoveryProbe),
    Announce(DiscoveryAnnounce),
}

impl DiscoveryMsg {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("magic".into(), Value::String(MAGIC.into()));
        map.insert("proto".into(), json_number(SYNC_PROTO as f64));
        match self {
            DiscoveryMsg::Probe(probe) => {
                map.insert("kind".into(), Value::String("probe".into()));
                map.insert("deviceId".into(), Value::String(probe.device_id.clone()));
                map.insert(
                    "deviceName".into(),
                    Value::String(probe.device_name.clone()),
                );
            }
            DiscoveryMsg::Announce(announce) => {
                map.insert("kind".into(), Value::String("announce".into()));
                map.insert("deviceId".into(), Value::String(announce.device_id.clone()));
                map.insert(
                    "deviceName".into(),
                    Value::String(announce.device_name.clone()),
                );
                map.insert(
                    "appVersion".into(),
                    Value::String(announce.app_version.clone()),
                );
                map.insert("tcpPort".into(), json_number(announce.tcp_port as f64));
                map.insert(
                    "sessionId".into(),
                    Value::String(announce.session_id.clone()),
                );
            }
        }
        Value::Object(map)
    }
}

/// 稳定的错误码。napi 层把它编码成 `OFS_LANSYNC_<CODE>[:payload]` 的 reason，
/// TS 侧再映射回现有的中文消息 —— 线上可见文案一个字都不许变。
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum FrameError {
    #[error("FrameLenInvalid({0})")]
    FrameLenInvalid(u32),
    #[error("FrameJsonInvalid")]
    FrameJsonInvalid,
    #[error("FrameShapeInvalid")]
    FrameShapeInvalid,
}

impl FrameError {
    pub fn code(&self) -> &'static str {
        match self {
            FrameError::FrameLenInvalid(_) => "FrameLenInvalid",
            FrameError::FrameJsonInvalid => "FrameJsonInvalid",
            FrameError::FrameShapeInvalid => "FrameShapeInvalid",
        }
    }

    pub fn payload(&self) -> Option<String> {
        match self {
            FrameError::FrameLenInvalid(len) => Some(len.to_string()),
            _ => None,
        }
    }

    /// `OFS_LANSYNC_FRAME_LEN_INVALID:123` 这种形式；`src/main/core/native.ts` 解析它。
    pub fn reason(&self) -> String {
        match self.payload() {
            Some(payload) => format!("OFS_LANSYNC_{}:{}", to_screaming(self.code()), payload),
            None => format!("OFS_LANSYNC_{}", to_screaming(self.code())),
        }
    }
}

fn to_screaming(code: &str) -> String {
    let mut out = String::with_capacity(code.len() + 4);
    for (index, ch) in code.chars().enumerate() {
        if ch.is_ascii_uppercase() && index > 0 {
            out.push('_');
        }
        out.push(ch.to_ascii_uppercase());
    }
    out
}

fn json_number(value: f64) -> Value {
    match serde_json::Number::from_f64(value) {
        Some(number) => Value::Number(number),
        // 非有限数在 JSON.stringify 里会变成 null，encode 阶段由 js_json 再兜一次。
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_always_emits_defaulted_counts_in_declaration_order() {
        let frame = SyncFrame::Applied {
            profiles: 1.0,
            groups: 0.0,
            proxies: 0.0,
            private_keys: 0.0,
            ai_profiles: 0.0,
            snippets: 2.0,
            forwards: 3.0,
            known_hosts: 4.0,
            secrets: 5.0,
            skipped: 6.0,
        };
        let keys: Vec<String> = match frame.to_value() {
            Value::Object(map) => map.keys().cloned().collect(),
            other => panic!("expected object, got {other:?}"),
        };
        assert_eq!(
            keys,
            vec![
                "kind",
                "profiles",
                "groups",
                "proxies",
                "privateKeys",
                "aiProfiles",
                "snippets",
                "forwards",
                "knownHosts",
                "secrets",
                "skipped"
            ]
        );
    }

    #[test]
    fn error_reason_uses_screaming_snake_case() {
        assert_eq!(
            FrameError::FrameLenInvalid(7).reason(),
            "OFS_LANSYNC_FRAME_LEN_INVALID:7"
        );
        assert_eq!(
            FrameError::FrameJsonInvalid.reason(),
            "OFS_LANSYNC_FRAME_JSON_INVALID"
        );
        assert_eq!(
            FrameError::FrameShapeInvalid.reason(),
            "OFS_LANSYNC_FRAME_SHAPE_INVALID"
        );
    }
}
