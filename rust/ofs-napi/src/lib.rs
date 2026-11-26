//! napi-rs 绑定层 —— 唯一产出 `.node` 的 crate。
//!
//! 对外只暴露 lansync 的纯函数加一个拆帧器类；错误一律以
//! `OFS_LANSYNC_<CODE>[:payload]` 的 reason 抛出，由 `src/main/core/native.ts`
//! 映射回现有的中文消息。任何 I/O、任何状态机都不在这一层。
//!
//! JS 值 → `serde_json::Value` 是手写转换，没有直接用 napi 的 `serde-json`
//! 实现：那套实现对 `undefined` / 函数 / Symbol 直接报错，而 `JSON.stringify`
//! 是**跳过**它们。`encodeFrame({kind:'error', code, params: undefined})` 这种
//! 入参在 TS 侧完全合法，字节也确定，所以这里必须照 JSON.stringify 的语义走。

use napi::bindgen_prelude::*;
// `Unknown` / `ValueType` 由 crate 根导出（`pub use js_values::*`），
// 不在 bindgen_prelude 的显式清单里，所以单独引入。
use napi::{Unknown, ValueType};
use napi_derive::napi;
use ofs_contract::{FrameError, MAX_FRAME_BYTES};
use ofs_lansync::{discovery, js_json, reader::FrameReader, validate};
use serde_json::{Map, Number, Value};

fn to_napi_error(error: FrameError) -> Error {
    Error::from_reason(error.reason())
}

fn unsupported(kind: &str) -> Error {
    Error::from_reason(format!("OFS_LANSYNC_UNSUPPORTED_VALUE:{kind}"))
}

/// 与 `JSON.stringify` 一致的 JS → JSON 转换：`undefined` / 函数 / Symbol
/// 在对象里被跳过、在数组里变成 `null`；BigInt 直接抛（V8 同样抛 TypeError）。
fn js_to_value(value: &Unknown<'_>) -> Result<Option<Value>> {
    match value.get_type()? {
        ValueType::Undefined | ValueType::Function | ValueType::Symbol => Ok(None),
        ValueType::Null => Ok(Some(Value::Null)),
        ValueType::Boolean => Ok(Some(Value::Bool(unsafe { value.cast::<bool>()? }))),
        ValueType::Number => {
            let number: f64 = unsafe { value.cast()? };
            // Infinity / NaN 在 JSON.stringify 里是 null。
            Ok(Some(match Number::from_f64(number) {
                Some(number) => Value::Number(number),
                None => Value::Null,
            }))
        }
        ValueType::String => Ok(Some(Value::String(unsafe { value.cast::<String>()? }))),
        ValueType::BigInt => Err(unsupported("bigint")),
        ValueType::Object => {
            let object: Object<'_> = unsafe { value.cast()? };
            if object.is_array()? {
                let array: Array<'_> = unsafe { value.cast()? };
                let mut items = Vec::with_capacity(array.len() as usize);
                for index in 0..array.len() {
                    let item = array.get::<Unknown<'_>>(index)?;
                    items.push(match item {
                        Some(item) => js_to_value(&item)?.unwrap_or(Value::Null),
                        None => Value::Null,
                    });
                }
                Ok(Some(Value::Array(items)))
            } else {
                let mut map = Map::new();
                for key in Object::keys(&object)? {
                    // `get` 把「缺失」和「undefined」都归成 None —— 正是要的语义。
                    if let Some(property) = object.get::<Unknown<'_>>(&key)? {
                        if let Some(item) = js_to_value(&property)? {
                            map.insert(key, item);
                        }
                    }
                }
                Ok(Some(Value::Object(map)))
            }
        }
        other => Err(unsupported(&other.to_string())),
    }
}

fn frame_from_js(value: &Unknown<'_>) -> Result<Value> {
    js_to_value(value)?.ok_or_else(|| unsupported("undefined"))
}

#[napi(js_name = "lansyncEncodeDiscovery")]
pub fn lansync_encode_discovery(msg: Unknown<'_>) -> Result<Buffer> {
    let value = frame_from_js(&msg)?;
    Ok(Buffer::from(ofs_lansync::encode_discovery_value(&value)))
}

#[napi(js_name = "lansyncDecodeDiscovery")]
pub fn lansync_decode_discovery(buf: Buffer) -> Option<Value> {
    discovery::decode_bytes(buf.as_ref()).map(|msg| msg.to_value())
}

#[napi(js_name = "lansyncEncodeFrame")]
pub fn lansync_encode_frame(frame: Unknown<'_>) -> Result<Buffer> {
    let value = frame_from_js(&frame)?;
    Ok(Buffer::from(ofs_lansync::encode_frame_value(&value)))
}

/// 拆帧器。`feed` 只返回本次凑齐的帧；坏帧以稳定错误码抛出。
#[napi]
pub struct NativeFrameReader {
    inner: std::sync::Mutex<FrameReader>,
}

#[napi]
impl NativeFrameReader {
    #[napi(constructor)]
    pub fn new(max_bytes: Option<f64>) -> Self {
        Self {
            inner: std::sync::Mutex::new(FrameReader::new(
                max_bytes.unwrap_or(MAX_FRAME_BYTES as f64),
            )),
        }
    }

    #[napi]
    pub fn feed(&self, chunk: Buffer) -> Result<Vec<Value>> {
        let mut reader = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("OFS_LANSYNC_READER_POISONED"))?;
        let frames = reader
            .feed(chunk.as_ref().to_vec())
            .map_err(to_napi_error)?;
        Ok(frames.iter().map(|frame| frame.to_value()).collect())
    }

    #[napi(js_name = "setMaxBytes")]
    pub fn set_max_bytes(&self, max_bytes: f64) -> Result<()> {
        let mut reader = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("OFS_LANSYNC_READER_POISONED"))?;
        reader.set_max_bytes(max_bytes);
        Ok(())
    }

    #[napi]
    pub fn buffered(&self) -> Result<u32> {
        let reader = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("OFS_LANSYNC_READER_POISONED"))?;
        Ok(reader.buffered() as u32)
    }
}

#[napi(js_name = "lansyncFrameReaderNew")]
pub fn lansync_frame_reader_new(
    env: &Env,
    max_bytes: Option<f64>,
) -> Result<ClassInstance<'_, NativeFrameReader>> {
    NativeFrameReader::new(max_bytes).into_instance(env)
}

#[napi(js_name = "nativeVersion")]
pub fn native_version() -> String {
    format!(
        "{}/{}/{}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[napi(js_name = "nativeAbiLevel")]
pub fn native_abi_level() -> u32 {
    8
}

/// 给打包校验脚本用的自检：解析 → 序列化必须闭环。
#[napi(js_name = "nativeSelfTest")]
pub fn native_self_test() -> bool {
    let parsed: Value = match serde_json::from_str(r#"{"kind":"received"}"#) {
        Ok(value) => value,
        Err(_) => return false,
    };
    match validate::parse_frame(&parsed) {
        Some(frame) => js_json::to_string(&frame.to_value()) == r#"{"kind":"received"}"#,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn self_test_round_trips() {
        assert!(super::native_self_test());
    }
}
