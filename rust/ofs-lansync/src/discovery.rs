//! UDP 发现报文。与 TCP 侧相反：这里任何失败都返回 `None`。
//!
//! 那个端口上收到什么都不奇怪（别的软件、扫描器、损坏包），丢弃是常态而不是异常。

use ofs_contract::{DiscoveryMsg, MAX_DATAGRAM_BYTES};
use serde_json::Value;

use crate::validate;

pub fn decode_bytes(buf: &[u8]) -> Option<DiscoveryMsg> {
    if buf.len() > MAX_DATAGRAM_BYTES {
        return None;
    }
    // `buf.toString('utf8')` 是 lossy 的，这里必须一致。
    let text = String::from_utf8_lossy(buf);
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let map = parsed.as_object()?;
    match map.get("kind")?.as_str()? {
        "probe" => validate::parse_probe(map).map(DiscoveryMsg::Probe),
        "announce" => validate::parse_announce(map).map(DiscoveryMsg::Announce),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ofs_contract::{DiscoveryProbe, MAX_DATAGRAM_BYTES};

    #[test]
    fn round_trips_a_probe() {
        let text = r#"{"magic":"OFSSYNC1","proto":1,"kind":"probe","deviceId":"dev-a","deviceName":"PC-A"}"#;
        assert_eq!(
            decode_bytes(text.as_bytes()),
            Some(DiscoveryMsg::Probe(DiscoveryProbe {
                device_id: "dev-a".into(),
                device_name: "PC-A".into(),
            }))
        );
    }

    #[test]
    fn garbage_is_silently_dropped() {
        assert_eq!(decode_bytes(b"not json"), None);
        assert_eq!(
            decode_bytes(
                br#"{"magic":"NOPE","proto":1,"kind":"probe","deviceId":"d","deviceName":""}"#
            ),
            None
        );
        assert_eq!(
            decode_bytes(
                br#"{"magic":"OFSSYNC1","proto":2,"kind":"probe","deviceId":"d","deviceName":""}"#
            ),
            None
        );
        assert_eq!(decode_bytes(br#"{"kind":"hi"}"#), None);
        let oversized = vec![b' '; MAX_DATAGRAM_BYTES + 1];
        assert_eq!(decode_bytes(&oversized), None);
    }

    #[test]
    fn announce_port_bounds() {
        let base = |port: i64| {
            format!(
                r#"{{"magic":"OFSSYNC1","proto":1,"kind":"announce","deviceId":"d","deviceName":"n","appVersion":"1","tcpPort":{port},"sessionId":"s"}}"#
            )
        };
        assert!(decode_bytes(base(1).as_bytes()).is_some());
        assert!(decode_bytes(base(65535).as_bytes()).is_some());
        assert_eq!(decode_bytes(base(0).as_bytes()), None);
        assert_eq!(decode_bytes(base(70000).as_bytes()), None);
    }
}
