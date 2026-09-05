#include "unicode.h"

namespace ofs::rdp {
namespace {

void appendUtf16(std::vector<std::uint8_t>& output, std::uint16_t value) {
  output.push_back(static_cast<std::uint8_t>(value));
  output.push_back(static_cast<std::uint8_t>(value >> 8));
}

void appendUtf8(std::string& output, std::uint32_t value) {
  if (value <= 0x7f) {
    output.push_back(static_cast<char>(value));
  } else if (value <= 0x7ff) {
    output.push_back(static_cast<char>(0xc0u | (value >> 6)));
    output.push_back(static_cast<char>(0x80u | (value & 0x3fu)));
  } else if (value <= 0xffff) {
    output.push_back(static_cast<char>(0xe0u | (value >> 12)));
    output.push_back(static_cast<char>(0x80u | ((value >> 6) & 0x3fu)));
    output.push_back(static_cast<char>(0x80u | (value & 0x3fu)));
  } else {
    output.push_back(static_cast<char>(0xf0u | (value >> 18)));
    output.push_back(static_cast<char>(0x80u | ((value >> 12) & 0x3fu)));
    output.push_back(static_cast<char>(0x80u | ((value >> 6) & 0x3fu)));
    output.push_back(static_cast<char>(0x80u | (value & 0x3fu)));
  }
}

}  // namespace

bool isUnicodeScalar(std::uint32_t value) {
  return value <= 0x10ffffu && !(value >= 0xd800u && value <= 0xdfffu);
}

bool utf8ToUtf16Le(std::string_view input, std::vector<std::uint8_t>& output,
                   bool appendNull) {
  output.clear();
  output.reserve(input.size() * 2 + (appendNull ? 2 : 0));
  for (std::size_t offset = 0; offset < input.size();) {
    const auto lead = static_cast<std::uint8_t>(input[offset]);
    std::uint32_t value = 0;
    std::size_t count = 0;
    std::uint32_t minimum = 0;
    if (lead <= 0x7f) {
      value = lead;
      count = 1;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      value = lead & 0x1fu;
      count = 2;
      minimum = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      value = lead & 0x0fu;
      count = 3;
      minimum = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      value = lead & 0x07u;
      count = 4;
      minimum = 0x10000;
    } else {
      output.clear();
      return false;
    }
    if (offset + count > input.size()) {
      output.clear();
      return false;
    }
    for (std::size_t index = 1; index < count; ++index) {
      const auto continuation = static_cast<std::uint8_t>(input[offset + index]);
      if ((continuation & 0xc0u) != 0x80u) {
        output.clear();
        return false;
      }
      value = (value << 6) | (continuation & 0x3fu);
    }
    if (value < minimum || !isUnicodeScalar(value)) {
      output.clear();
      return false;
    }
    if (value <= 0xffffu) {
      appendUtf16(output, static_cast<std::uint16_t>(value));
    } else {
      const std::uint32_t scalar = value - 0x10000u;
      appendUtf16(output, static_cast<std::uint16_t>(0xd800u + (scalar >> 10)));
      appendUtf16(output, static_cast<std::uint16_t>(0xdc00u + (scalar & 0x3ffu)));
    }
    offset += count;
  }
  if (appendNull) appendUtf16(output, 0);
  return true;
}

bool utf16LeToUtf8(const std::uint8_t* input, std::size_t length, std::string& output,
                   bool stopAtNull) {
  output.clear();
  if ((length & 1u) != 0 || (length != 0 && input == nullptr)) return false;
  output.reserve(length);
  for (std::size_t offset = 0; offset < length; offset += 2) {
    const auto unit = static_cast<std::uint16_t>(
        static_cast<std::uint16_t>(input[offset]) |
        (static_cast<std::uint16_t>(input[offset + 1]) << 8));
    if (unit == 0 && stopAtNull) return true;
    std::uint32_t value = unit;
    if (unit >= 0xd800u && unit <= 0xdbffu) {
      if (offset + 3 >= length) {
        output.clear();
        return false;
      }
      const auto low = static_cast<std::uint16_t>(
          static_cast<std::uint16_t>(input[offset + 2]) |
          (static_cast<std::uint16_t>(input[offset + 3]) << 8));
      if (low < 0xdc00u || low > 0xdfffu) {
        output.clear();
        return false;
      }
      value = 0x10000u + ((unit - 0xd800u) << 10) + (low - 0xdc00u);
      offset += 2;
    } else if (unit >= 0xdc00u && unit <= 0xdfffu) {
      output.clear();
      return false;
    }
    appendUtf8(output, value);
  }
  return true;
}

}  // namespace ofs::rdp
