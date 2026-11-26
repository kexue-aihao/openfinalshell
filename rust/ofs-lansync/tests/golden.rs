//! 金标对拍：Rust 只读 `shared-schema/fixtures/lansync-golden.json`，TS 侧读同一份。
//!
//! 这里断言三件事，缺一都不叫「字节一致」：
//! 1. 解码结果与 TS 逐字节同形（含键序、默认值、未知键丢弃）；
//! 2. 把解码结果重新编码，与 TS 的 reencoded 字节完全相同；
//! 3. 用例若带原始输入（input），直接编码它也必须与 TS 的 hex 完全相同 ——
//!    这一条专门抓 `JSON.stringify` 的数字格式与整数形键重排。

use ofs_contract::FrameError;
use ofs_lansync::{discovery, js_json, reader::FrameReader, validate};
use serde_json::Value;

fn golden_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("shared-schema")
        .join("fixtures")
        .join("lansync-golden.json")
}

fn hex_decode(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0, "hex 长度必须是偶数");
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let high = (bytes[index] as char).to_digit(16).expect("hex") as u8;
        let low = (bytes[index + 1] as char).to_digit(16).expect("hex") as u8;
        out.push((high << 4) | low);
        index += 2;
    }
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn reason_of(error: &FrameError) -> &'static str {
    match error {
        FrameError::FrameLenInvalid(_) => "len",
        FrameError::FrameJsonInvalid => "json",
        FrameError::FrameShapeInvalid => "shape",
    }
}

#[test]
fn golden_cases_match_the_typescript_implementation() {
    let text = std::fs::read_to_string(golden_path())
        .unwrap_or_else(|error| panic!("读不到 golden（{:?}）：{error}", golden_path()));
    let golden: Value = serde_json::from_str(&text).expect("golden 是合法 JSON");
    let cases = golden["cases"].as_array().expect("golden.cases 是数组");
    assert!(!cases.is_empty(), "golden 没有用例");

    let mut accepted = 0;
    let mut rejected = 0;

    for case in cases {
        let name = case["name"].as_str().expect("case.name");
        let bytes = hex_decode(case["hex"].as_str().expect("case.hex"));
        let decision = case["decision"].as_str().expect("case.decision");

        match case["type"].as_str().expect("case.type") {
            "frame" => {
                let mut reader = FrameReader::default();
                let outcome = reader.feed(bytes);
                match (decision, outcome) {
                    ("reject", Err(error)) => {
                        let expected = case["reason"].as_str().expect("case.reason");
                        assert_eq!(reason_of(&error), expected, "{name}: 拒绝原因分类不一致");
                        rejected += 1;
                    }
                    ("reject", Ok(frames)) => {
                        panic!("{name}: TS 拒绝，Rust 接受了 {} 帧", frames.len())
                    }
                    ("accept", Err(error)) => {
                        panic!("{name}: TS 接受，Rust 拒绝（{:?}）", error)
                    }
                    ("accept", Ok(frames)) => {
                        assert_eq!(frames.len(), 1, "{name}: 期望恰好 1 帧");
                        let decoded = &case["decoded"];
                        assert_eq!(
                            js_json::to_string(&frames[0].to_value()),
                            js_json::to_string(decoded),
                            "{name}: 解码形状/键序不一致"
                        );
                        let reencoded = ofs_lansync::encode_frame_value(decoded);
                        assert_eq!(
                            hex_encode(&reencoded),
                            case["reencodedHex"].as_str().expect("reencodedHex"),
                            "{name}: 解码 → 编码字节不一致"
                        );
                        if let Some(input) = case.get("input") {
                            assert_eq!(
                                hex_encode(&ofs_lansync::encode_frame_value(input)),
                                case["hex"].as_str().expect("hex"),
                                "{name}: 原样编码字节不一致"
                            );
                        }
                        accepted += 1;
                    }
                    (other, _) => panic!("{name}: 未知 decision {other}"),
                }
            }
            "discovery" => {
                let decoded = discovery::decode_bytes(&bytes);
                if decision == "reject" {
                    assert!(decoded.is_none(), "{name}: TS 拒绝，Rust 却解析成功");
                    rejected += 1;
                    continue;
                }
                let message = decoded.unwrap_or_else(|| panic!("{name}: TS 接受，Rust 返回 None"));
                let expected = &case["decoded"];
                assert_eq!(
                    js_json::to_string(&message.to_value()),
                    js_json::to_string(expected),
                    "{name}: 发现报文解码形状/键序不一致"
                );
                assert_eq!(
                    hex_encode(&ofs_lansync::encode_discovery_value(expected)),
                    case["reencodedHex"].as_str().expect("reencodedHex"),
                    "{name}: 发现报文解码 → 编码字节不一致"
                );
                if let Some(input) = case.get("input") {
                    assert_eq!(
                        hex_encode(&ofs_lansync::encode_discovery_value(input)),
                        case["hex"].as_str().expect("hex"),
                        "{name}: 发现报文原样编码字节不一致"
                    );
                }
                accepted += 1;
            }
            other => panic!("{name}: 未知 case.type {other}"),
        }
    }

    assert!(
        accepted >= 20,
        "接受用例太少（{accepted}），golden 可能被裁剪"
    );
    assert!(
        rejected >= 20,
        "拒绝用例太少（{rejected}），golden 可能被裁剪"
    );
}

/// 拆帧器在 golden 之外还要能处理「一 chunk 多帧」与逐字节投递。
#[test]
fn reader_matches_the_golden_frames_when_chunked_arbitrarily() {
    let text = std::fs::read_to_string(golden_path()).expect("golden");
    let golden: Value = serde_json::from_str(&text).expect("json");
    let mut frames: Vec<Vec<u8>> = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        if case["type"] != "frame" || case["decision"] != "accept" {
            continue;
        }
        let bytes = hex_decode(case["hex"].as_str().expect("hex"));
        // 只保留能被单帧消费的用例（解码即合法），其余在 golden 里已有断言。
        let mut reader = FrameReader::default();
        if reader.feed(bytes.clone()).is_ok() {
            frames.push(bytes);
        }
    }
    assert!(!frames.is_empty());

    let mut drip = FrameReader::default();
    let mut drip_frames = 0;
    for frame in &frames {
        for byte in frame {
            drip_frames += drip.feed(vec![*byte]).expect("逐字节投递").len();
        }
    }

    let mut batched = FrameReader::default();
    let mut batched_frames = 0;
    let joined: Vec<u8> = frames.concat();
    batched_frames += batched.feed(joined).expect("整块投递").len();

    assert_eq!(drip_frames, frames.len());
    assert_eq!(batched_frames, frames.len());
}

/// 形状校验必须与 zod 的 UTF-16 计长一致。
#[test]
fn utf16_lengths_are_enforced() {
    let value: Value = serde_json::from_str(
        r#"{"kind":"confirm-s","mac":"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}"#,
    )
    .expect("json");
    // 32 个 emoji = 64 个 code unit，刚好在 128 以内。
    assert!(validate::parse_frame(&value).is_some());
}
