#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "unicode.h"
#include "file_clipboard.h"
#include "frame_protocol.h"

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

#if !defined(OFS_RDP_HAS_FREERDP)
#define OFS_RDP_HAS_FREERDP 0
#endif

#include "freerdp_adapter.h"

namespace {
constexpr std::uint32_t kMaxPayload = ofs::rdp::frame::kMaxPayload;
constexpr std::uint32_t kFrameMetadataSize = ofs::rdp::frame::kFrameHeaderSize +
                                              ofs::rdp::frame::kRectHeaderSize;
constexpr std::uint32_t kFrameHeaderSize = ofs::rdp::frame::kFrameHeaderSize;
constexpr std::uint32_t kRectHeaderSize = ofs::rdp::frame::kRectHeaderSize;
constexpr std::uint32_t kMaxFrameRects = ofs::rdp::frame::kMaxFrameRects;
constexpr std::uint64_t kMaxDisplayPixels = ofs::rdp::frame::kMaxDisplayPixels;
constexpr std::uint32_t kMaxFullRectPixels = (kMaxPayload - kFrameMetadataSize) / 4u;
constexpr char kMagic[4] = {'O', 'F', 'S', 'R'};
constexpr std::uint16_t kVersion = 1;
constexpr std::size_t kHeaderSize = 16;
std::mutex gOutputMutex;

enum MessageType : std::uint8_t {
  HELLO = 0x01,
  HELLO_ACK = 0x02,
  START = 0x10,
  CREDENTIAL = 0x11,
  CLOSE = 0x12,
  RESIZE = 0x13,
  KEY = 0x14,
  POINTER = 0x15,
  CLIPBOARD_SET = 0x16,
  CLIPBOARD_GET = 0x17,
  CLIPBOARD_FILES_SET = 0x18,
  CLIPBOARD_LOCAL_FILES = 0x19,
  CLIPBOARD_SYNC = 0x1a,
  CLIPBOARD_FILES_DOWNLOAD = 0x1b,
  CLIPBOARD_LOCAL_DATA = 0x25,
  STATE = 0x20,
  PROMPT = 0x21,
  CLIPBOARD_DATA = 0x22,
  CLIPBOARD_PROGRESS = 0x24,
  REMOTE_FILES = 0x26,
  DOWNLOAD_RESULT = 0x27,
  AUDIO_STATE = 0x23,
  FRAME = 0x30,
  ERROR = 0x7f
};

struct Display {
  std::uint32_t width = 1280;
  std::uint32_t height = 720;
  std::uint32_t dpi = 96;
};

enum class ReadResult { ok, eof, protocolError };

void put16(std::vector<std::uint8_t>& out, std::uint16_t value) {
  out.push_back(static_cast<std::uint8_t>(value));
  out.push_back(static_cast<std::uint8_t>(value >> 8));
}

void put32(std::vector<std::uint8_t>& out, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(value >> (8 * i)));
}

std::uint32_t get32(const std::uint8_t* in) {
  return static_cast<std::uint32_t>(in[0]) |
         (static_cast<std::uint32_t>(in[1]) << 8) |
         (static_cast<std::uint32_t>(in[2]) << 16) |
         (static_cast<std::uint32_t>(in[3]) << 24);
}

bool readExact(std::istream& in, std::uint8_t* dst, std::size_t size) {
  if (size == 0) return true;
  in.read(reinterpret_cast<char*>(dst), static_cast<std::streamsize>(size));
  return static_cast<std::size_t>(in.gcount()) == size;
}

std::size_t skipSpace(std::string_view json, std::size_t pos) {
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' || json[pos] == '\r' || json[pos] == '\n')) ++pos;
  return pos;
}

struct JsonValue {
  enum class Type { nullValue, boolean, number, string, array, object };

  Type type = Type::nullValue;
  bool boolean = false;
  std::string scalar;
  std::vector<JsonValue> array;
  std::vector<std::pair<std::string, JsonValue>> object;
};

class JsonParser {
 public:
  explicit JsonParser(std::string_view source) : source_(source) {}

  bool parse(JsonValue& value) {
    pos_ = skipSpace(source_, 0);
    if (!parseValue(value, 0)) return false;
    pos_ = skipSpace(source_, pos_);
    return pos_ == source_.size();
  }

 private:
  static constexpr std::size_t kMaxDepth = 64;

  bool parseValue(JsonValue& value, std::size_t depth) {
    if (depth > kMaxDepth || pos_ >= source_.size()) return false;
    const char current = source_[pos_];
    if (current == '{') return parseObject(value, depth + 1);
    if (current == '[') return parseArray(value, depth + 1);
    if (current == '"') {
      value = JsonValue{};
      value.type = JsonValue::Type::string;
      return parseString(value.scalar);
    }
    if (current == 't' && consumeLiteral("true")) {
      value = JsonValue{};
      value.type = JsonValue::Type::boolean;
      value.boolean = true;
      return true;
    }
    if (current == 'f' && consumeLiteral("false")) {
      value = JsonValue{};
      value.type = JsonValue::Type::boolean;
      value.boolean = false;
      return true;
    }
    if (current == 'n' && consumeLiteral("null")) {
      value = JsonValue{};
      value.type = JsonValue::Type::nullValue;
      return true;
    }
    if (current == '-' || (current >= '0' && current <= '9')) {
      value = JsonValue{};
      value.type = JsonValue::Type::number;
      return parseNumber(value.scalar);
    }
    return false;
  }

  bool parseObject(JsonValue& value, std::size_t depth) {
    ++pos_;
    value = JsonValue{};
    value.type = JsonValue::Type::object;
    pos_ = skipSpace(source_, pos_);
    if (pos_ < source_.size() && source_[pos_] == '}') {
      ++pos_;
      return true;
    }
    while (true) {
      if (pos_ >= source_.size() || source_[pos_] != '"') return false;
      std::string key;
      if (!parseString(key)) return false;
      pos_ = skipSpace(source_, pos_);
      if (pos_ >= source_.size() || source_[pos_] != ':') return false;
      pos_ = skipSpace(source_, pos_ + 1);
      JsonValue child;
      if (!parseValue(child, depth)) return false;
      for (const auto& member : value.object) {
        if (member.first == key) return false;
      }
      value.object.emplace_back(std::move(key), std::move(child));
      pos_ = skipSpace(source_, pos_);
      if (pos_ >= source_.size()) return false;
      if (source_[pos_] == '}') {
        ++pos_;
        return true;
      }
      if (source_[pos_] != ',') return false;
      pos_ = skipSpace(source_, pos_ + 1);
      // A member is mandatory after every comma, which excludes trailing commas.
      if (pos_ >= source_.size() || source_[pos_] != '"') return false;
    }
  }

  bool parseArray(JsonValue& value, std::size_t depth) {
    ++pos_;
    value = JsonValue{};
    value.type = JsonValue::Type::array;
    pos_ = skipSpace(source_, pos_);
    if (pos_ < source_.size() && source_[pos_] == ']') {
      ++pos_;
      return true;
    }
    while (true) {
      JsonValue child;
      if (!parseValue(child, depth)) return false;
      value.array.emplace_back(std::move(child));
      pos_ = skipSpace(source_, pos_);
      if (pos_ >= source_.size()) return false;
      if (source_[pos_] == ']') {
        ++pos_;
        return true;
      }
      if (source_[pos_] != ',') return false;
      pos_ = skipSpace(source_, pos_ + 1);
      // A JSON value is mandatory after every comma, which excludes trailing commas.
      if (pos_ >= source_.size() || source_[pos_] == ']') return false;
    }
  }

  bool parseString(std::string& out) {
    if (pos_ >= source_.size() || source_[pos_] != '"') return false;
    ++pos_;
    out.clear();
    while (pos_ < source_.size()) {
      const unsigned char current = static_cast<unsigned char>(source_[pos_++]);
      if (current == '"') return true;
      if (current < 0x20) return false;
      if (current != '\\') {
        out.push_back(static_cast<char>(current));
        continue;
      }
      if (pos_ >= source_.size()) return false;
      const char escaped = source_[pos_++];
      switch (escaped) {
        case '"': case '\\': case '/': out.push_back(escaped); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          std::uint32_t codepoint = 0;
          if (!parseHex16(codepoint)) return false;
          if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
            if (pos_ + 2 > source_.size() || source_[pos_] != '\\' || source_[pos_ + 1] != 'u') return false;
            pos_ += 2;
            std::uint32_t low = 0;
            if (!parseHex16(low) || low < 0xdc00 || low > 0xdfff) return false;
            codepoint = 0x10000u + ((codepoint - 0xd800u) << 10) + (low - 0xdc00u);
          } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
            return false;
          }
          appendUtf8(out, codepoint);
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool parseHex16(std::uint32_t& value) {
    if (pos_ + 4 > source_.size()) return false;
    value = 0;
    for (int digit = 0; digit < 4; ++digit) {
      const char hex = source_[pos_++];
      value <<= 4;
      if (hex >= '0' && hex <= '9') value |= static_cast<std::uint32_t>(hex - '0');
      else if (hex >= 'a' && hex <= 'f') value |= static_cast<std::uint32_t>(hex - 'a' + 10);
      else if (hex >= 'A' && hex <= 'F') value |= static_cast<std::uint32_t>(hex - 'A' + 10);
      else return false;
    }
    return true;
  }

  static void appendUtf8(std::string& out, std::uint32_t codepoint) {
    if (codepoint < 0x80) {
      out.push_back(static_cast<char>(codepoint));
    } else if (codepoint < 0x800) {
      out.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
      out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else if (codepoint < 0x10000) {
      out.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
      out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else {
      out.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
      out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
      out.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    }
  }

  bool parseNumber(std::string& value) {
    const std::size_t start = pos_;
    if (source_[pos_] == '-') ++pos_;
    if (pos_ >= source_.size()) return false;
    if (source_[pos_] == '0') {
      ++pos_;
    } else if (source_[pos_] >= '1' && source_[pos_] <= '9') {
      do { ++pos_; } while (pos_ < source_.size() && source_[pos_] >= '0' && source_[pos_] <= '9');
    } else {
      return false;
    }
    if (pos_ < source_.size() && source_[pos_] == '.') {
      ++pos_;
      const std::size_t fraction = pos_;
      while (pos_ < source_.size() && source_[pos_] >= '0' && source_[pos_] <= '9') ++pos_;
      if (pos_ == fraction) return false;
    }
    if (pos_ < source_.size() && (source_[pos_] == 'e' || source_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < source_.size() && (source_[pos_] == '+' || source_[pos_] == '-')) ++pos_;
      const std::size_t exponent = pos_;
      while (pos_ < source_.size() && source_[pos_] >= '0' && source_[pos_] <= '9') ++pos_;
      if (pos_ == exponent) return false;
    }
    value.assign(source_.substr(start, pos_ - start));
    return true;
  }

  bool consumeLiteral(std::string_view literal) {
    if (source_.substr(pos_, literal.size()) != literal) return false;
    pos_ += literal.size();
    return true;
  }

  std::string_view source_;
  std::size_t pos_ = 0;
};

const JsonValue* jsonMember(const JsonValue& object, std::string_view key) {
  if (object.type != JsonValue::Type::object) return nullptr;
  for (const auto& member : object.object) {
    if (member.first == key) return &member.second;
  }
  return nullptr;
}

bool jsonHasOnlyMembers(const JsonValue& object, const std::vector<std::string_view>& expected) {
  if (object.type != JsonValue::Type::object || object.object.size() != expected.size()) return false;
  for (const auto& member : object.object) {
    if (std::find(expected.begin(), expected.end(), member.first) == expected.end()) return false;
  }
  return true;
}

bool jsonHasUniqueKnownMembers(const JsonValue& object,
                               const std::vector<std::string_view>& expected) {
  if (object.type != JsonValue::Type::object) return false;
  for (std::size_t index = 0; index < object.object.size(); ++index) {
    const auto& member = object.object[index];
    if (std::find(expected.begin(), expected.end(), member.first) == expected.end()) return false;
    for (std::size_t previous = 0; previous < index; ++previous) {
      if (object.object[previous].first == member.first) return false;
    }
  }
  return true;
}

bool jsonString(const JsonValue& object, std::string_view key, std::string& value) {
  const JsonValue* member = jsonMember(object, key);
  if (member == nullptr || member->type != JsonValue::Type::string) return false;
  value = member->scalar;
  return true;
}

bool jsonUint(const JsonValue& object, std::string_view key, std::uint32_t& value) {
  const JsonValue* member = jsonMember(object, key);
  if (member == nullptr || member->type != JsonValue::Type::number || member->scalar.empty()) return false;
  std::uint64_t parsed = 0;
  for (const char digit : member->scalar) {
    if (digit < '0' || digit > '9') return false;
    const auto next = static_cast<unsigned>(digit - '0');
    if (parsed > (std::numeric_limits<std::uint64_t>::max() - next) / 10u) return false;
    parsed = parsed * 10u + next;
    if (parsed > std::numeric_limits<std::uint32_t>::max()) return false;
  }
  value = static_cast<std::uint32_t>(parsed);
  return true;
}

bool jsonUint64(const JsonValue& object, std::string_view key, std::uint64_t& value) {
  const JsonValue* member = jsonMember(object, key);
  if (member == nullptr || member->type != JsonValue::Type::number || member->scalar.empty()) return false;
  std::uint64_t parsed = 0;
  for (const char digit : member->scalar) {
    if (digit < '0' || digit > '9') return false;
    const auto next = static_cast<std::uint64_t>(digit - '0');
    if (parsed > (std::numeric_limits<std::uint64_t>::max() - next) / 10u) return false;
    parsed = parsed * 10u + next;
  }
  value = parsed;
  return true;
}

bool jsonInt(const JsonValue& object, std::string_view key, std::int32_t& value) {
  const JsonValue* member = jsonMember(object, key);
  if (member == nullptr || member->type != JsonValue::Type::number || member->scalar.empty()) return false;
  std::size_t pos = 0;
  bool negative = false;
  if (member->scalar[pos] == '-') {
    negative = true;
    if (++pos == member->scalar.size()) return false;
  }
  std::int64_t parsed = 0;
  for (; pos < member->scalar.size(); ++pos) {
    const char digit = member->scalar[pos];
    if (digit < '0' || digit > '9') return false;
    const auto next = static_cast<std::int64_t>(digit - '0');
    const auto limit = std::numeric_limits<std::int64_t>::max() - next;
    if (parsed > limit / 10) return false;
    parsed = parsed * 10 + next;
    if (parsed > static_cast<std::int64_t>(std::numeric_limits<std::int32_t>::max()) + (negative ? 1 : 0)) return false;
  }
  const std::int64_t signedValue = negative ? -parsed : parsed;
  if (signedValue < std::numeric_limits<std::int32_t>::min() || signedValue > std::numeric_limits<std::int32_t>::max()) return false;
  value = static_cast<std::int32_t>(signedValue);
  return true;
}

bool jsonBool(const JsonValue& object, std::string_view key, bool& value) {
  const JsonValue* member = jsonMember(object, key);
  if (member == nullptr || member->type != JsonValue::Type::boolean) return false;
  value = member->boolean;
  return true;
}

bool jsonOp(const JsonValue& object, std::string& op) { return jsonString(object, "op", op); }

bool validDisplay(const Display& display) {
  return ofs::rdp::frame::validCanvas(display.width, display.height) &&
         display.dpi >= 96 && display.dpi <= 384;
}

bool writeFrame(std::uint8_t type, std::uint32_t requestId, const std::vector<std::uint8_t>& payload) {
  std::lock_guard<std::mutex> lock(gOutputMutex);
  if (payload.size() > kMaxPayload) return false;
  std::uint8_t header[kHeaderSize]{};
  std::memcpy(header, kMagic, sizeof(kMagic));
  header[4] = static_cast<std::uint8_t>(kVersion);
  header[5] = static_cast<std::uint8_t>(kVersion >> 8);
  header[6] = type;
  header[7] = 0;
  const auto length = static_cast<std::uint32_t>(payload.size());
  header[8] = static_cast<std::uint8_t>(length);
  header[9] = static_cast<std::uint8_t>(length >> 8);
  header[10] = static_cast<std::uint8_t>(length >> 16);
  header[11] = static_cast<std::uint8_t>(length >> 24);
  header[12] = static_cast<std::uint8_t>(requestId);
  header[13] = static_cast<std::uint8_t>(requestId >> 8);
  header[14] = static_cast<std::uint8_t>(requestId >> 16);
  header[15] = static_cast<std::uint8_t>(requestId >> 24);
  std::cout.write(reinterpret_cast<const char*>(header), static_cast<std::streamsize>(sizeof(header)));
  if (!payload.empty()) std::cout.write(reinterpret_cast<const char*>(payload.data()), static_cast<std::streamsize>(payload.size()));
  std::cout.flush();
  return std::cout.good();
}

bool writeJson(std::uint8_t type, std::uint32_t requestId, const std::string& json) {
  return writeFrame(type, requestId, std::vector<std::uint8_t>(json.begin(), json.end()));
}

void protocolError(std::uint32_t requestId, const char* message) {
  std::cerr << "[rdp-worker] protocol error request=" << requestId << ": " << message << '\n';
  writeJson(ERROR, requestId, std::string("{\"op\":\"error\",\"code\":\"PROTOCOL_ERROR\",\"message\":\"") + message + "\"}");
}

void state(std::uint32_t requestId, const char* value) {
  writeJson(STATE, requestId, std::string("{\"op\":\"state\",\"state\":\"") + value + "\"}");
}

void ack(std::uint32_t requestId) {
  writeJson(STATE, requestId, R"({"op":"ack"})");
}

bool writeMockFrame(const Display& display, std::uint32_t sequence) {
  const std::uint64_t pixels = static_cast<std::uint64_t>(display.width) * display.height;
  const std::uint32_t rectX = 0;
  const std::uint32_t rectY = 0;
  const std::uint32_t rectWidth = pixels <= kMaxFullRectPixels ? display.width : 1;
  const std::uint32_t rectHeight = pixels <= kMaxFullRectPixels ? display.height : 1;
  const std::uint64_t bytes = static_cast<std::uint64_t>(rectWidth) * rectHeight * 4u;
  if (!ofs::rdp::frame::validRect(display.width, display.height,
                                  static_cast<std::int32_t>(rectX),
                                  static_cast<std::int32_t>(rectY), rectWidth,
                                  rectHeight, rectWidth * 4u,
                                  static_cast<std::size_t>(bytes), kFrameHeaderSize))
    return false;
  try {
    std::vector<std::uint8_t> frame;
    frame.reserve(static_cast<std::size_t>(bytes) + kFrameMetadataSize);
    put32(frame, display.width);
    put32(frame, display.height);
    put32(frame, sequence);
    put16(frame, 1);
    put16(frame, 0);
    put32(frame, rectX);
    put32(frame, rectY);
    put32(frame, rectWidth);
    put32(frame, rectHeight);
    put32(frame, rectWidth * 4u);
    put32(frame, static_cast<std::uint32_t>(bytes));
    frame.resize(frame.size() + static_cast<std::size_t>(bytes));
    // rdp-frame-v1 carries canonical RGBA8888 pixels.
    for (std::size_t i = kFrameMetadataSize; i < frame.size(); i += 4) {
      frame[i] = 0x66;
      frame[i + 1] = 0x44;
      frame[i + 2] = 0x22;
      frame[i + 3] = 0xff;
    }
    return writeFrame(FRAME, 0, frame);
  } catch (const std::bad_alloc&) {
    return false;
  }
}

std::string jsonEscape(std::string_view value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const unsigned char c : value) {
    switch (c) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (c < 0x20) {
          static constexpr char hex[] = "0123456789abcdef";
          escaped += "\\u00";
          escaped.push_back(hex[c >> 4]);
          escaped.push_back(hex[c & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(c));
        }
    }
  }
  return escaped;
}

#if OFS_RDP_HAS_FREERDP
bool writeFreeRdpFrame(std::uint32_t canvasWidth, std::uint32_t canvasHeight, std::uint32_t sequence,
                       const std::vector<FreeRdpAdapter::Rect>& rects) {
  if (rects.empty() || rects.size() > kMaxFrameRects ||
      !ofs::rdp::frame::validCanvas(canvasWidth, canvasHeight))
    return false;
  std::uint64_t payloadBytes = kFrameHeaderSize;
  for (const auto& rect : rects) {
    if (!ofs::rdp::frame::validRect(canvasWidth, canvasHeight, rect.x, rect.y,
                                    rect.width, rect.height, rect.stride,
                                    rect.pixels.size(), payloadBytes))
      return false;
    payloadBytes += kRectHeaderSize + rect.pixels.size();
  }
  try {
    std::vector<std::uint8_t> frame;
    frame.reserve(static_cast<std::size_t>(payloadBytes));
    put32(frame, canvasWidth);
    put32(frame, canvasHeight);
    put32(frame, sequence);
    put16(frame, static_cast<std::uint16_t>(rects.size()));
    put16(frame, 0);
    for (const auto& rect : rects) {
      put32(frame, static_cast<std::uint32_t>(rect.x));
      put32(frame, static_cast<std::uint32_t>(rect.y));
      put32(frame, rect.width);
      put32(frame, rect.height);
      put32(frame, rect.stride);
      put32(frame, static_cast<std::uint32_t>(rect.pixels.size()));
      frame.insert(frame.end(), rect.pixels.begin(), rect.pixels.end());
    }
    return writeFrame(FRAME, 0, frame);
  } catch (const std::bad_alloc&) {
    return false;
  }
}
#endif

struct InputFrame {
  std::vector<std::uint8_t> payload;
  std::uint8_t type = 0;
  std::uint32_t requestId = 0;
};

ReadResult readFrame(InputFrame& frame) {
  frame = InputFrame{};
  std::uint8_t header[kHeaderSize]{};
  std::cin.read(reinterpret_cast<char*>(header), static_cast<std::streamsize>(sizeof(header)));
  const auto count = static_cast<std::size_t>(std::cin.gcount());
  if (count == 0 && std::cin.eof()) return ReadResult::eof;
  if (count != sizeof(header)) return ReadResult::protocolError;
  if (std::memcmp(header, kMagic, sizeof(kMagic)) != 0) return ReadResult::protocolError;
  if (header[4] != static_cast<std::uint8_t>(kVersion) || header[5] != static_cast<std::uint8_t>(kVersion >> 8)) return ReadResult::protocolError;
  if (header[7] != 0) return ReadResult::protocolError;
  const std::uint32_t length = get32(header + 8);
  if (length > kMaxPayload) return ReadResult::protocolError;
  const std::uint8_t type = header[6];
  const std::uint32_t requestId = get32(header + 12);
  std::vector<std::uint8_t> payload;
  try {
    payload.resize(length);
  } catch (const std::bad_alloc&) {
    return ReadResult::protocolError;
  }
  if (!readExact(std::cin, payload.data(), length)) return ReadResult::protocolError;
  frame.type = type;
  frame.requestId = requestId;
  frame.payload = std::move(payload);
  return ReadResult::ok;
}

void selfTest() {
#if OFS_RDP_HAS_FREERDP
  writeJson(HELLO, 0, R"({"op":"hello","protocol":1,"workerVersion":"freerdp","capabilities":["freerdp","framebuffer","input","resize","clipboard","audio"]})");
#else
  writeJson(HELLO, 0, R"({"op":"hello","protocol":1,"workerVersion":"mock","capabilities":["mock","framebuffer","input","resize","clipboard"]})");
#endif
}
} // namespace

int main(int argc, char** argv) {
#if defined(_WIN32)
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  if (argc > 1 && std::string(argv[1]) == "--self-test") {
    selfTest();
    return 0;
  }

#if OFS_RDP_HAS_FREERDP
  writeJson(HELLO, 0, R"({"op":"hello","protocol":1,"workerVersion":"freerdp","capabilities":["freerdp","framebuffer","input","resize","clipboard","audio"]})");
#else
  writeJson(HELLO, 0, R"({"op":"hello","protocol":1,"workerVersion":"mock","capabilities":["mock","framebuffer","input","resize","clipboard"]})");
#endif
  bool handshaken = false;
  bool started = false;
  std::atomic_bool ready{false};
  [[maybe_unused]] std::string certificatePolicy = "prompt";
  Display display;
  std::uint32_t sequence = 0;
  std::vector<std::uint32_t> pendingCertificateRequests;
#if OFS_RDP_HAS_FREERDP
  std::unique_ptr<FreeRdpAdapter> backend;
#endif
  InputFrame frame;
  while (true) {
    const ReadResult result = readFrame(frame);
    if (result == ReadResult::eof) return 0;
    if (result == ReadResult::protocolError) {
      protocolError(frame.requestId, "invalid frame header, length, or truncated payload");
      return 2;
    }
    if (frame.type != HELLO_ACK && frame.type != START && frame.type != CREDENTIAL && frame.type != CLOSE &&
        frame.type != RESIZE && frame.type != KEY && frame.type != POINTER && frame.type != CLIPBOARD_SET &&
        frame.type != CLIPBOARD_GET && frame.type != CLIPBOARD_FILES_SET && frame.type != CLIPBOARD_LOCAL_FILES &&
        frame.type != CLIPBOARD_SYNC && frame.type != CLIPBOARD_FILES_DOWNLOAD) {
      protocolError(frame.requestId, "unknown message type");
      return 2;
    }
    if (!ofs::rdp::validUtf8(frame.payload.data(), frame.payload.size())) {
      protocolError(frame.requestId, "control payload is not UTF-8");
      return 2;
    }
    const std::string json(frame.payload.begin(), frame.payload.end());
    JsonValue control;
    JsonParser parser(json);
    if (!parser.parse(control) || control.type != JsonValue::Type::object) {
      protocolError(frame.requestId, "control payload must be a JSON object");
      return 2;
    }
    std::string op;
    if (!jsonOp(control, op)) {
      protocolError(frame.requestId, "control payload must contain op");
      return 2;
    }

    if (frame.type == HELLO_ACK) {
      std::uint32_t protocol = 0;
      std::string sessionId;
      if (handshaken || op != "helloAck" || !jsonUint(control, "protocol", protocol) || protocol != kVersion ||
          !jsonUint(control, "maxPayload", protocol) || protocol != kMaxPayload || !jsonString(control, "sessionId", sessionId) || sessionId.empty()) {
        protocolError(frame.requestId, "invalid helloAck");
        return 2;
      }
      handshaken = true;
      continue;
    }

    if (!handshaken) {
      protocolError(frame.requestId, "helloAck required before control messages");
      return 2;
    }

    if (frame.type == START) {
      std::string host;
      std::string username;
      std::string domain;
      std::uint32_t port = 0;
      const JsonValue* gateway = jsonMember(control, "gateway");
      const JsonValue* displayValue = jsonMember(control, "display");
      const JsonValue* features = jsonMember(control, "features");
      if (started || op != "start" ||
          !jsonHasOnlyMembers(control, {"op", "host", "port", "username", "domain", "gateway", "display", "features"}) ||
          !jsonString(control, "host", host) || host.empty() ||
          !jsonUint(control, "port", port) || port < 1 || port > 65535 ||
          !jsonString(control, "username", username) || !jsonString(control, "domain", domain) ||
          gateway == nullptr || displayValue == nullptr || features == nullptr) {
        protocolError(frame.requestId, "invalid start payload");
        return 2;
      }
      if (gateway->type != JsonValue::Type::nullValue) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"RDP gateway is not supported"})");
        return 2;
      }
      std::uint32_t width = 0, height = 0, dpi = 0;
      bool clipboard = false;
      bool audioPlayback = true;
      std::string nextCertificatePolicy;
      const JsonValue* audioPlaybackValue = jsonMember(*features, "audioPlayback");
      if (!jsonHasOnlyMembers(*displayValue, {"width", "height", "dpi"}) ||
          !jsonUint(*displayValue, "width", width) || !jsonUint(*displayValue, "height", height) ||
          !jsonUint(*displayValue, "dpi", dpi) ||
          !jsonHasUniqueKnownMembers(*features, {"clipboard", "certificatePolicy", "audioPlayback"}) ||
          !jsonBool(*features, "clipboard", clipboard) ||
          !jsonString(*features, "certificatePolicy", nextCertificatePolicy) ||
          (nextCertificatePolicy != "prompt" && nextCertificatePolicy != "strict") ||
          (audioPlaybackValue != nullptr && !jsonBool(*features, "audioPlayback", audioPlayback))) {
        protocolError(frame.requestId, "display is required");
        return 2;
      }
      display = {width, height, dpi};
      if (!validDisplay(display)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"display dimensions are outside supported limits"})");
        return 2;
      }
      started = true;
      ready = false;
      certificatePolicy = std::move(nextCertificatePolicy);
      state(frame.requestId, "connecting");
#if OFS_RDP_HAS_FREERDP
      backend = std::make_unique<FreeRdpAdapter>();
      FreeRdpAdapter::Config config;
      config.host = host;
      config.port = static_cast<std::uint16_t>(port);
      config.username = username;
      config.domain = domain;
      config.display = {display.width, display.height, display.dpi};
      config.clipboard = clipboard;
      config.audioPlayback = audioPlayback;
      config.certificatePolicy = certificatePolicy;
      const bool backendStarted = backend->start(
          std::move(config),
          [&](const char* value, const char* errorCode) {
            if (std::strcmp(value, "ready") == 0) ready = true;
            if (errorCode != nullptr) {
              writeJson(STATE, 0, std::string("{\"op\":\"state\",\"state\":\"") + value +
                                    "\",\"errorCode\":\"" + errorCode + "\"}");
            } else {
              state(0, value);
            }
          },
          [&](std::uint32_t requestId, const char* promptHost, std::uint16_t promptPort,
              const char* subject, const char* issuer, const char* fingerprint, bool changed) {
            const std::string payload = std::string("{\"op\":\"prompt\",\"kind\":\"certificate\",\"requestId\":") +
                std::to_string(requestId) + ",\"payload\":{\"host\":\"" + jsonEscape(promptHost ? promptHost : "") +
                "\",\"port\":" + std::to_string(promptPort) + ",\"subject\":\"" + jsonEscape(subject ? subject : "") +
                "\",\"issuer\":\"" + jsonEscape(issuer ? issuer : "") + "\",\"fingerprintSha256\":\"" +
                jsonEscape(fingerprint ? fingerprint : "") + "\",\"changed\":" + (changed ? "true" : "false") + "}}";
            writeJson(PROMPT, requestId, payload);
          },
          [&](std::uint32_t canvasWidth, std::uint32_t canvasHeight, std::uint32_t frameSequence,
              std::vector<FreeRdpAdapter::Rect> rects) {
            if (!writeFreeRdpFrame(canvasWidth, canvasHeight, frameSequence, rects)) {
              std::cerr << "[rdp-worker] rejected framebuffer update: canvas=" << canvasWidth << 'x'
                        << canvasHeight << ", sequence=" << frameSequence << ", rects=" << rects.size()
                        << '\n';
              std::cerr.flush();
              writeJson(ERROR, 0, R"({"op":"error","code":"PROTOCOL_ERROR","message":"invalid framebuffer update"})");
            }
          },
           [&](std::uint32_t requestId, std::string text, bool files) {
             if (files) {
               writeJson(CLIPBOARD_DATA, requestId, R"({"op":"clipboardData","mime":"application/x-ofs-rdp-files"})");
               return;
             }
             const std::string escaped = jsonEscape(text);
             writeJson(CLIPBOARD_DATA, requestId, std::string("{\"op\":\"clipboardData\",\"mime\":\"text/plain\",\"text\":\"") + escaped + "\"}");
           },
           [&](const char* progressState, std::uint32_t fileIndex, std::uint32_t fileCount,
               const char* fileName, std::uint64_t transferred, std::uint64_t total,
               double speedBps, const char* errorCode) {
             std::string payload = std::string("{\"op\":\"clipboardProgress\",\"state\":\"") +
                 jsonEscape(progressState ? progressState : "failed") + "\",\"fileIndex\":" +
                 std::to_string(fileIndex) + ",\"fileCount\":" + std::to_string(fileCount) +
                 ",\"transferred\":" + std::to_string(transferred) + ",\"total\":" +
                 std::to_string(total) + ",\"speedBps\":" + std::to_string(speedBps);
             if (fileName != nullptr) payload += std::string(",\"fileName\":\"") + jsonEscape(fileName) + "\"";
             if (errorCode != nullptr) payload += std::string(",\"error\":\"") + jsonEscape(errorCode) + "\"";
             payload += "}";
             writeJson(CLIPBOARD_PROGRESS, 0, payload);
           },
           [&](const char* audioState, const char* errorCode) {
            std::string payload = std::string("{\"op\":\"audio\",\"state\":\"") +
                jsonEscape(audioState ? audioState : "stopped") + "\"";
            if (errorCode != nullptr) payload += std::string(",\"errorCode\":\"") + jsonEscape(errorCode) + "\"";
            payload += "}";
            writeJson(AUDIO_STATE, 0, payload);
          },
           [&](std::vector<FreeRdpAdapter::RemoteFileEntry> files) {
             std::string payload = "{\"op\":\"remoteFiles\",\"files\":[";
             bool first = true;
             for (const auto& file : files) {
               if (!first) payload += ",";
               first = false;
               payload += "{\"name\":\"" + jsonEscape(file.name) + "\",\"size\":" +
                          std::to_string(file.size) + ",\"directory\":" +
                          (file.directory ? "true" : "false") + "}";
             }
             payload += "]}";
             writeJson(REMOTE_FILES, 0, payload);
           });
      if (!backendStarted) {
        std::cerr << "[rdp-worker] FreeRDP backend initialization failed\n";
        std::cerr.flush();
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"FreeRDP backend initialization failed"})");
        state(frame.requestId, "failed");
        return 2;
      }
#else
      if (!writeMockFrame(display, ++sequence)) return 2;
      ready = true;
      state(frame.requestId, "ready");
#endif
      continue;
    }

    if (frame.type == CREDENTIAL) {
      std::string kind, value;
      if (op == "credential" && jsonString(control, "kind", kind) && kind == "password" && jsonString(control, "value", value)) {
        // Password bytes are intentionally consumed only in-process and never logged.
#if OFS_RDP_HAS_FREERDP
        if (!backend || !backend->providePassword(value)) {
          std::cerr << "[rdp-worker] password delivery failed\n";
          std::cerr.flush();
          writeJson(ERROR, frame.requestId, R"({"op":"error","code":"AUTH_FAILED","message":"RDP credentials were rejected"})");
          return 2;
        }
#endif
        ack(frame.requestId);
        continue;
      }
      bool accept = false;
      std::uint32_t requestId = 0;
      if (op == "certificate" && jsonHasOnlyMembers(control, {"op", "requestId", "accept"}) &&
          jsonUint(control, "requestId", requestId) && jsonBool(control, "accept", accept)) {
        if (frame.requestId == 0 || requestId == 0 || requestId != frame.requestId) continue;
#if OFS_RDP_HAS_FREERDP
        if (backend && backend->provideCertificate(requestId, accept)) {
          if (!accept) {
            std::cerr << "[rdp-worker] certificate rejected by user, request=" << requestId << '\n';
            std::cerr.flush();
            writeJson(ERROR, frame.requestId, R"({"op":"error","code":"CERTIFICATE_REJECTED","message":"certificate rejected"})");
            return 2;
          }
          ack(frame.requestId);
          continue;
        }
#endif
        const auto pending = std::find(pendingCertificateRequests.begin(), pendingCertificateRequests.end(), requestId);
        if (pending == pendingCertificateRequests.end()) continue;
        pendingCertificateRequests.erase(pending);
        if (!accept) {
          writeJson(ERROR, frame.requestId, R"({"op":"error","code":"CERTIFICATE_REJECTED","message":"certificate rejected"})");
          return 2;
        }
        ack(frame.requestId);
        continue;
      }
      protocolError(frame.requestId, "invalid credential payload");
      return 2;
    }

    if (frame.type == CLIPBOARD_SYNC) {
      bool enabled = false;
      if (!jsonHasOnlyMembers(control, {"op", "enabled"}) || op != "clipboardSync" ||
          !jsonBool(control, "enabled", enabled)) {
        protocolError(frame.requestId, "invalid clipboardSync payload");
        return 2;
      }
#if OFS_RDP_HAS_FREERDP
      if (backend) backend->setClipboardSync(enabled);
#endif
      ack(frame.requestId);
      continue;
    }

    if (frame.type == CLIPBOARD_FILES_DOWNLOAD) {
      std::string directory;
      if (op != "remoteFilesDownload" || !jsonString(control, "directory", directory) ||
          directory.empty() || directory.size() > 32768) {
        protocolError(frame.requestId, "invalid remoteFilesDownload payload");
        return 2;
      }
      std::string result = "{\"op\":\"downloadResult\",\"state\":\"failed\",\"fileCount\":0,\"error\":\"DOWNLOAD_UNAVAILABLE\"}";
#if OFS_RDP_HAS_FREERDP
      const bool ok = backend && backend->remoteFilesDownload(directory);
      if (ok) {
        result = "{\"op\":\"downloadResult\",\"state\":\"completed\",\"fileCount\":" +
            std::to_string(backend->remoteClipboardFileCount()) + "}";
      }
#endif
      writeJson(DOWNLOAD_RESULT, frame.requestId, result);
      continue;
    }

    if (frame.type == CLOSE) {
      std::string reason;
      if (op != "close" || !jsonString(control, "reason", reason) || (reason != "user" && reason != "reconnect" && reason != "shutdown")) {
        protocolError(frame.requestId, "invalid close payload");
        return 2;
      }
#if OFS_RDP_HAS_FREERDP
      if (backend) backend->close();
#endif
      state(frame.requestId, "closed");
      return 0;
    }

    if (!started || !ready) {
      writeJson(ERROR, frame.requestId, R"({"op":"error","code":"SESSION_NOT_READY","message":"session is not ready"})");
      continue;
    }

    if (frame.type == RESIZE) {
      std::uint32_t width = 0, height = 0, dpi = 0;
      if (op != "resize" || !jsonUint(control, "width", width) || !jsonUint(control, "height", height) || !jsonUint(control, "dpi", dpi)) {
        protocolError(frame.requestId, "invalid resize payload");
        return 2;
      }
      Display next{width, height, dpi};
      if (!validDisplay(next)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"display dimensions are outside supported limits"})");
        continue;
      }
      display = next;
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->resize({display.width, display.height, display.dpi})) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"dynamic desktop resize is unavailable"})");
        continue;
      }
#endif
      ack(frame.requestId);
#if OFS_RDP_HAS_FREERDP
#else
      writeMockFrame(display, ++sequence);
#endif
      continue;
    }

    if (frame.type == KEY) {
      std::uint32_t scanCode = 0;
      bool pressed = false;
      bool extended = false;
      std::uint32_t unicode = 0;
      bool hasUnicode = false;
      const JsonValue* extendedValue = jsonMember(control, "extended");
      const JsonValue* unicodeValue = jsonMember(control, "unicode");
      if (op != "key" || !jsonUint(control, "scanCode", scanCode) || !jsonBool(control, "pressed", pressed) ||
          !jsonHasUniqueKnownMembers(control, {"op", "scanCode", "pressed", "extended", "unicode"}) ||
          (extendedValue != nullptr && !jsonBool(control, "extended", extended))) {
        protocolError(frame.requestId, "invalid key payload");
        return 2;
      }
      if (unicodeValue != nullptr) {
        if (!jsonUint(control, "unicode", unicode) || !ofs::rdp::isUnicodeScalar(unicode)) {
          protocolError(frame.requestId, "invalid Unicode scalar");
          return 2;
        }
        hasUnicode = true;
      }
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->key(scanCode, pressed, extended,
                                    hasUnicode ? std::optional<std::uint32_t>(unicode) : std::nullopt)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"SESSION_NOT_READY","message":"RDP input is unavailable"})");
        continue;
      }
#endif
      if (frame.requestId != 0) ack(frame.requestId);
      continue;
    }

    if (frame.type == POINTER) {
      std::uint32_t x = 0, y = 0, buttons = 0;
      std::int32_t wheelX = 0, wheelY = 0;
      const JsonValue* wheelXValue = jsonMember(control, "wheelX");
      const JsonValue* wheelYValue = jsonMember(control, "wheelY");
      if (op != "pointer" || !jsonUint(control, "x", x) || !jsonUint(control, "y", y) || !jsonUint(control, "buttons", buttons) ||
          (wheelXValue != nullptr && !jsonInt(control, "wheelX", wheelX)) ||
          (wheelYValue != nullptr && !jsonInt(control, "wheelY", wheelY))) {
        protocolError(frame.requestId, "invalid pointer payload");
        return 2;
      }
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->pointer(x, y, buttons, wheelX, wheelY)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"SESSION_NOT_READY","message":"RDP input is unavailable"})");
        continue;
      }
#endif
      if (frame.requestId != 0) ack(frame.requestId);
      continue;
    }

    if (frame.type == CLIPBOARD_SET) {
      std::string mime, text;
      if (op != "clipboardSet" || !jsonString(control, "mime", mime) || mime != "text/plain" || !jsonString(control, "text", text)) {
        protocolError(frame.requestId, "invalid clipboard payload");
        return 2;
      }
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->clipboardSet(text)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"clipboard is unavailable"})");
        continue;
      }
#endif
      ack(frame.requestId);
      continue;
    }

    if (frame.type == CLIPBOARD_LOCAL_FILES) {
      if (op != "clipboardLocalFiles" || !jsonHasOnlyMembers(control, {"op"})) {
        protocolError(frame.requestId, "invalid local clipboard request"); return 2;
      }
      std::string payload = "{\"op\":\"clipboardLocalFiles\",\"files\":[";
      bool first = true;
      for (const auto& path : ofs::rdp::localClipboardFiles()) {
        if (!first) payload += ",";
        first = false; payload += "\"" + jsonEscape(path) + "\"";
      }
      writeJson(CLIPBOARD_LOCAL_DATA, frame.requestId, payload + "]}");
      continue;
    }

    if (frame.type == CLIPBOARD_FILES_SET) {
      const JsonValue* filesValue = jsonMember(control, "files");
      if (op != "clipboardFilesSet" || filesValue == nullptr || filesValue->type != JsonValue::Type::array ||
          filesValue->array.empty() || filesValue->array.size() > 64 ||
          !jsonHasOnlyMembers(control, {"op", "files"})) {
        protocolError(frame.requestId, "invalid clipboard files payload");
        return 2;
      }
      std::vector<FreeRdpAdapter::ClipboardFile> files;
      files.reserve(filesValue->array.size());
      for (const auto& value : filesValue->array) {
        std::string path;
        std::string name;
        std::uint64_t size = 0;
        bool directory = false;
        if (!jsonHasUniqueKnownMembers(value, {"path", "name", "size", "directory"}) ||
            (jsonMember(value, "directory") && !jsonBool(value, "directory", directory)) ||
            !jsonString(value, "path", path) || !jsonString(value, "name", name) ||
            !jsonUint64(value, "size", size) || path.empty() || path.size() > 32768 ||
            name.empty() || name.size() > 2048 || size > 8ull * 1024ull * 1024ull * 1024ull) {
          protocolError(frame.requestId, "invalid clipboard file entry");
          return 2;
        }
        files.push_back({std::move(path), std::move(name), size, directory});
      }
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->clipboardFilesSet(std::move(files))) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"file clipboard is unavailable"})");
        continue;
      }
#else
      writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"file clipboard is unavailable"})");
      continue;
#endif
      ack(frame.requestId);
      continue;
    }

    if (frame.type == CLIPBOARD_GET) {
      std::uint32_t requested = 0;
      if (op != "clipboardGet" || !jsonUint(control, "requestId", requested)) {
        protocolError(frame.requestId, "invalid clipboard request");
        return 2;
      }
#if OFS_RDP_HAS_FREERDP
      if (!backend || !backend->clipboardGet(requested)) {
        writeJson(ERROR, frame.requestId, R"({"op":"error","code":"UNSUPPORTED","message":"clipboard is unavailable"})");
        continue;
      }
#else
      writeJson(CLIPBOARD_DATA, requested, R"({"op":"clipboardData","mime":"text/plain","text":""})");
#endif
      continue;
    }
  }
}
