//! zod schema 的手写对应物。
//!
//! 每个谓词都对着 `src/main/lansync/protocol.ts` 里的那一行写：
//!
//! - `z.string().min(a).max(b)` 按 **UTF-16 code unit** 计长（`é` 是 1，`😀` 是 2），
//!   所以这里用 `encode_utf16().count()`，不是 `chars().count()` 也不是 `len()`；
//! - `z.number().int().min(0)` 要的是 `Number.isInteger` + 非负，`1e20` 合法，
//!   `Infinity`/`NaN`/小数非法，所以内部一律 `f64` 而不是整数类型；
//! - 未知键一律丢弃（zod 默认 strip），所以返回的是定长结构体而不是原对象；
//! - `z.record` 保持输入键序，且 zod 会丢掉 `__proto__` 键。

use ofs_contract::{
    DiscoveryAnnounce, DiscoveryProbe, ErrorParams, ParamValue, SyncFrame, MAGIC, SYNC_PROTO,
};
use serde_json::{Map, Value};

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn parse_frame(value: &Value) -> Option<SyncFrame> {
    let map = value.as_object()?;
    match map.get("kind")?.as_str()? {
        "hello" => Some(SyncFrame::Hello {
            magic: literal_text(map, "magic", MAGIC)?,
            proto: literal_integer(map, "proto", SYNC_PROTO)?,
            device_id: text_field(map, "deviceId", 1, Some(64))?,
            device_name: text_field(map, "deviceName", 0, Some(128))?,
            app_version: text_field(map, "appVersion", 0, Some(32))?,
            sender_pub: text_field(map, "senderPub", 1, Some(128))?,
        }),
        "hello-ack" => Some(SyncFrame::HelloAck {
            device_id: text_field(map, "deviceId", 1, Some(64))?,
            device_name: text_field(map, "deviceName", 0, Some(128))?,
            app_version: text_field(map, "appVersion", 0, Some(32))?,
            receiver_pub: text_field(map, "receiverPub", 1, Some(128))?,
            salt: text_field(map, "salt", 1, Some(64))?,
            session_id: text_field(map, "sessionId", 1, Some(64))?,
        }),
        "confirm-s" => Some(SyncFrame::ConfirmS {
            mac: text_field(map, "mac", 1, Some(128))?,
        }),
        "confirm-r" => Some(SyncFrame::ConfirmR {
            mac: text_field(map, "mac", 1, Some(128))?,
        }),
        "payload" => Some(SyncFrame::Payload {
            // 没有上限：本帧的长度由 4 字节前缀 + MAX_FRAME_BYTES 兜住。
            envelope: text_field(map, "envelope", 1, None)?,
        }),
        "received" => Some(SyncFrame::Received),
        "applied" => Some(SyncFrame::Applied {
            profiles: integer_field(map, "profiles", 0.0)?,
            // 这四个是 `.optional().default(0)`：缺省补 0，出现就必须合法。
            groups: defaulted_integer(map, "groups")?,
            proxies: defaulted_integer(map, "proxies")?,
            private_keys: defaulted_integer(map, "privateKeys")?,
            ai_profiles: defaulted_integer(map, "aiProfiles")?,
            snippets: integer_field(map, "snippets", 0.0)?,
            forwards: integer_field(map, "forwards", 0.0)?,
            known_hosts: integer_field(map, "knownHosts", 0.0)?,
            secrets: integer_field(map, "secrets", 0.0)?,
            skipped: integer_field(map, "skipped", 0.0)?,
        }),
        "rejected" => Some(SyncFrame::Rejected),
        "error" => {
            let params = match map.get("params") {
                None => None,
                Some(Value::Object(record)) => Some(parse_params(record)?),
                // `optional()` 只放过「缺席」，`params: null` 是非法的。
                Some(_) => return None,
            };
            Some(SyncFrame::Error {
                code: text_field(map, "code", 1, Some(64))?,
                params,
            })
        }
        _ => None,
    }
}

pub fn parse_probe(map: &Map<String, Value>) -> Option<DiscoveryProbe> {
    literal_text(map, "magic", MAGIC)?;
    literal_integer(map, "proto", SYNC_PROTO)?;
    Some(DiscoveryProbe {
        device_id: text_field(map, "deviceId", 1, Some(64))?,
        device_name: text_field(map, "deviceName", 0, Some(128))?,
    })
}

pub fn parse_announce(map: &Map<String, Value>) -> Option<DiscoveryAnnounce> {
    literal_text(map, "magic", MAGIC)?;
    literal_integer(map, "proto", SYNC_PROTO)?;
    let port = integer_field(map, "tcpPort", 1.0)?;
    if port > 65535.0 {
        return None;
    }
    Some(DiscoveryAnnounce {
        device_id: text_field(map, "deviceId", 1, Some(64))?,
        device_name: text_field(map, "deviceName", 0, Some(128))?,
        app_version: text_field(map, "appVersion", 0, Some(32))?,
        tcp_port: port as u16,
        session_id: text_field(map, "sessionId", 1, Some(64))?,
    })
}

fn parse_params(record: &Map<String, Value>) -> Option<ErrorParams> {
    let mut params = Vec::with_capacity(record.len());
    for (key, value) in record {
        // zod 的 mergeObjectSync 显式跳过这个键，避免原型污染。
        if key == "__proto__" {
            continue;
        }
        if utf16_len(key) > 32 {
            return None;
        }
        let param = match value {
            Value::String(text) if utf16_len(text) <= 256 => ParamValue::Text(text.clone()),
            Value::Number(number) => ParamValue::Number(number.as_f64().unwrap_or(f64::NAN)),
            _ => return None,
        };
        params.push((key.clone(), param));
    }
    Some(ErrorParams(params))
}

fn literal_text(map: &Map<String, Value>, key: &str, expected: &str) -> Option<String> {
    match map.get(key)? {
        Value::String(text) if text == expected => Some(text.clone()),
        _ => None,
    }
}

/// `z.literal(1)`：值必须**是数字**且与 1 相等（`true` 不算）。
fn literal_integer(map: &Map<String, Value>, key: &str, expected: i64) -> Option<i64> {
    match map.get(key)? {
        Value::Number(number) if number.as_f64() == Some(expected as f64) => Some(expected),
        _ => None,
    }
}

fn text_field(
    map: &Map<String, Value>,
    key: &str,
    min: usize,
    max: Option<usize>,
) -> Option<String> {
    let text = match map.get(key)? {
        Value::String(text) => text,
        _ => return None,
    };
    let length = utf16_len(text);
    if length < min {
        return None;
    }
    if let Some(max) = max {
        if length > max {
            return None;
        }
    }
    Some(text.clone())
}

/// `z.number().int().min(min)`。
fn integer_field(map: &Map<String, Value>, key: &str, min: f64) -> Option<f64> {
    match map.get(key)? {
        Value::Number(number) => {
            let value = number.as_f64()?;
            if !value.is_finite() || value.fract() != 0.0 || value < min {
                return None;
            }
            Some(value)
        }
        _ => None,
    }
}

/// `.optional().default(0)`：缺席补 0，出现则按 `integer_field` 校验。
fn defaulted_integer(map: &Map<String, Value>, key: &str) -> Option<f64> {
    if map.get(key).is_none() {
        return Some(0.0);
    }
    integer_field(map, key, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applied_defaults_are_filled() {
        let value = json!({
            "kind": "applied",
            "profiles": 1,
            "snippets": 2,
            "forwards": 3,
            "knownHosts": 4,
            "secrets": 5,
            "skipped": 6
        });
        match parse_frame(&value).expect("valid") {
            SyncFrame::Applied {
                groups,
                proxies,
                private_keys,
                ai_profiles,
                ..
            } => {
                assert_eq!(
                    (groups, proxies, private_keys, ai_profiles),
                    (0.0, 0.0, 0.0, 0.0)
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn string_lengths_are_utf16_code_units() {
        // mac 上限是 128 个 UTF-16 code unit：64 个 emoji = 128 恰好通过，
        // 65 个（130）必须被拒。按 `.length` 而不是字符数计数的实现会在这里红。
        let too_long = "😀".repeat(65);
        let value = json!({ "kind": "confirm-s", "mac": too_long });
        assert!(parse_frame(&value).is_none());
        let ok = "😀".repeat(64);
        assert!(parse_frame(&json!({ "kind": "confirm-s", "mac": ok })).is_some());
    }

    #[test]
    fn integer_semantics_match_zod() {
        assert!(parse_frame(&json!({
            "kind": "received"
        }))
        .is_some());
        // 小数、负数、布尔都不是 int().min(0)
        for bad in [json!(1.5), json!(-1), json!(true)] {
            let value = json!({
                "kind": "applied", "profiles": bad, "snippets": 0,
                "forwards": 0, "knownHosts": 0, "secrets": 0, "skipped": 0
            });
            assert!(parse_frame(&value).is_none(), "accepted {value}");
        }
        // 1e20 合法（u64 装不下，所以内部必须是 f64）
        let big = json!({
            "kind": "applied", "profiles": 1e20, "snippets": 0,
            "forwards": 0, "knownHosts": 0, "secrets": 0, "skipped": 0
        });
        assert!(parse_frame(&big).is_some());
    }

    #[test]
    fn params_keep_order_and_drop_proto() {
        let text =
            r#"{"kind":"error","code":"err.sync.busy","params":{"1":"a","b":2,"__proto__":"x"}}"#;
        let value: Value = serde_json::from_str(text).unwrap();
        match parse_frame(&value).expect("valid") {
            SyncFrame::Error {
                params: Some(params),
                ..
            } => {
                let keys: Vec<&str> = params.0.iter().map(|(key, _)| key.as_str()).collect();
                assert_eq!(keys, vec!["1", "b"]);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn params_null_is_rejected() {
        let value = json!({ "kind": "error", "code": "x", "params": null });
        assert!(parse_frame(&value).is_none());
    }

    #[test]
    fn discovery_port_bounds() {
        let base = json!({
            "magic": "OFSSYNC1", "proto": 1, "kind": "announce",
            "deviceId": "d", "deviceName": "n", "appVersion": "1",
            "sessionId": "s"
        });
        for (port, expected) in [(0, false), (1, true), (65535, true), (65536, false)] {
            let mut value = base.clone();
            value["tcpPort"] = json!(port);
            assert_eq!(
                parse_announce(value.as_object().unwrap()).is_some(),
                expected,
                "port {port}"
            );
        }
    }
}
