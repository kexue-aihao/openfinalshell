//! 与 `JSON.stringify` 逐字节一致的序列化器。
//!
//! 标准 `serde_json` 的输出在四个地方与 JS 不同，而 lansync 的差分测试是**字节级**
//! 的，任何一处都会让整条 lane 红：
//!
//! 1. `f64` 整数值：serde 输出 `1.0`，JS 输出 `1`；
//! 2. 零：serde 可能输出 `-0.0`，JS 输出 `0`；
//! 3. 指数形式：serde 输出 `1e21`，JS 输出 `1e+21`，且 JS 在 `1e21` 与 `1e-7`
//!    两个阈值上切换十进制/指数写法；
//! 4. 对象键序：V8 把「数组下标形」的键（`"0"`、`"10"`）提到最前并按数值升序，
//!    其余键保持插入序 —— `error.params` 的键完全可能是 `"1"`。
//!
//! 数字渲染严格按 ECMAScript `Number::toString` 的规则实现（最短往返数字由
//! `ryu` 提供，格式按规范重排），不是「差不多」。

use serde_json::{Map, Number, Value};

pub fn to_string(value: &Value) -> String {
    let mut out = String::with_capacity(64);
    write_value(&mut out, value);
    out
}

pub fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(out, number),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, key) in ordered_keys(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                if let Some(item) = map.get(key) {
                    write_value(out, item);
                } else {
                    out.push_str("null");
                }
            }
            out.push('}');
        }
    }
}

fn write_number(out: &mut String, number: &Number) {
    match number.as_f64() {
        // JSON.stringify 把 Infinity / NaN 写成 null（`1e999` 解析后正是 Infinity）。
        Some(value) if value.is_finite() => out.push_str(&format_number(value)),
        _ => out.push_str("null"),
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                out.push_str("\\u00");
                let code = ch as u32;
                out.push(hex_digit(((code >> 4) & 0xf) as u8));
                out.push(hex_digit((code & 0xf) as u8));
            }
            // 0x7f（DEL）与 U+2028/2029 在 JSON.stringify 里都是裸字符。
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'a' + (value - 10)) as char,
    }
}

/// ECMAScript `Number.prototype.toString()`（基数 10）的完整实现。
pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        // 覆盖 -0：JS 的 String(-0) 是 "0"。
        return "0".into();
    }
    let negative = value < 0.0;
    let magnitude = if negative { -value } else { value };
    let mut buffer = ryu::Buffer::new();
    let (digits, exponent) = decompose(buffer.format_finite(magnitude));
    let rendered = render(&digits, exponent);
    if negative {
        format!("-{rendered}")
    } else {
        rendered
    }
}

/// 把任意十进制表示拆成「无前导/尾随零的数字串 D」与指数 e，满足 `D × 10^e`。
fn decompose(text: &str) -> (String, i32) {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(index) => (
            &text[..index],
            text[index + 1..].parse::<i32>().unwrap_or(0),
        ),
        None => (text, 0),
    };
    let (integer_part, fraction_part) = match mantissa.find('.') {
        Some(index) => (&mantissa[..index], &mantissa[index + 1..]),
        None => (mantissa, ""),
    };

    let mut digits: String = String::with_capacity(integer_part.len() + fraction_part.len());
    digits.push_str(integer_part);
    digits.push_str(fraction_part);
    // value = digits × 10^(exponent - fraction_len)
    let mut power = exponent - fraction_part.len() as i32;

    while digits.len() > 1 && digits.starts_with('0') {
        digits.remove(0);
    }
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
        power += 1;
    }
    (digits, power)
}

/// ECMAScript 的四种输出形态（k = 数字位数，n = 小数点位置）。
fn render(digits: &str, power: i32) -> String {
    let k = digits.len() as i32;
    let n = power + k;
    if k <= n && n <= 21 {
        let mut out = String::with_capacity(n as usize);
        out.push_str(digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
        return out;
    }
    if 0 < n && n <= 21 {
        let split = n as usize;
        let mut out = String::with_capacity(digits.len() + 1);
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
        return out;
    }
    if -6 < n && n <= 0 {
        let mut out = String::with_capacity(digits.len() + 2 + (-n) as usize);
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(digits);
        return out;
    }
    let exponent = n - 1;
    let sign = if exponent >= 0 { '+' } else { '-' };
    let magnitude = exponent.abs();
    let mut out = String::with_capacity(digits.len() + 6);
    if k == 1 {
        out.push_str(digits);
    } else {
        out.push_str(&digits[..1]);
        out.push('.');
        out.push_str(&digits[1..]);
    }
    out.push('e');
    out.push(sign);
    out.push_str(&magnitude.to_string());
    out
}

/// V8 的键枚举序：数组下标形的键在前、按数值升序，其余保持插入序。
fn ordered_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut indices: Vec<(u32, &String)> = Vec::new();
    let mut others: Vec<&String> = Vec::new();
    for key in map.keys() {
        match array_index(key) {
            Some(index) => indices.push((index, key)),
            None => others.push(key),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    let mut ordered: Vec<&String> = indices.into_iter().map(|(_, key)| key).collect();
    ordered.append(&mut others);
    ordered
}

/// JS 的「数组下标」判定：规范十进制、无前导零、`0..=2^32-2`。
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    if key == "0" {
        return Some(0);
    }
    if key.starts_with('0') {
        return None;
    }
    let mut value: u64 = 0;
    for byte in key.bytes() {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(byte - b'0');
        if value > u64::from(u32::MAX) {
            return None;
        }
    }
    if value >= u64::from(u32::MAX) {
        return None;
    }
    Some(value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 固定用例表：计划书 §4.2 点名的每一个数字形态。
    #[test]
    fn numbers_match_json_stringify() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1"),
            (1.5, "1.5"),
            (-0.0, "0"),
            (0.0, "0"),
            (0.1_f64 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (9007199254740991.0, "9007199254740991"),
            (1e20, "100000000000000000000"),
            (123.456, "123.456"),
            (-1.5, "-1.5"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ];
        for (value, expected) in cases {
            assert_eq!(
                format_number(*value).as_str(),
                *expected,
                "value = {value:?}"
            );
        }
    }

    #[test]
    fn strings_match_json_stringify_escapes() {
        let text = "\"\\\n\t\u{1}\u{7f}é中文😀\u{2028}";
        assert_eq!(
            to_string(&Value::String(text.into())),
            "\"\\\"\\\\\\n\\t\\u0001\u{7f}é中文😀\u{2028}\""
        );
    }

    #[test]
    fn integer_like_keys_move_first() {
        let mut map = Map::new();
        map.insert("b".into(), json!(1));
        map.insert("10".into(), json!(2));
        map.insert("2".into(), json!(3));
        map.insert("a".into(), json!(4));
        assert_eq!(
            to_string(&Value::Object(map)),
            "{\"2\":3,\"10\":2,\"b\":1,\"a\":4}"
        );
    }

    #[test]
    fn non_finite_numbers_become_null() {
        assert_eq!(format_number(f64::INFINITY), "null");
        assert_eq!(format_number(f64::NAN), "null");
    }

    #[test]
    fn array_index_rule_matches_v8() {
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("01"), None);
        assert_eq!(array_index("4294967294"), Some(4294967294));
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("-1"), None);
        assert_eq!(array_index("1.0"), None);
    }
}
