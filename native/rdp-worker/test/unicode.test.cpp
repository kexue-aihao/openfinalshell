#include "unicode.h"

#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

bool expect(bool condition, const char* message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

bool rejectsUtf8(std::string_view input) {
  std::vector<std::uint8_t> converted;
  return !ofs::rdp::utf8ToUtf16Le(input, converted);
}

bool rejectsUtf16(std::vector<std::uint8_t> input) {
  std::string converted;
  return !ofs::rdp::utf16LeToUtf8(input.data(), input.size(), converted);
}

}  // namespace

int main() {
  bool ok = expect(ofs::rdp::isUnicodeScalar(0), "U+0000 is not a scalar") &&
            expect(ofs::rdp::isUnicodeScalar(0x10ffff), "U+10FFFF is not a scalar") &&
            expect(!ofs::rdp::isUnicodeScalar(0x110000), "accepted code point above Unicode") &&
            expect(!ofs::rdp::isUnicodeScalar(0xd800), "accepted high surrogate scalar") &&
            expect(!ofs::rdp::isUnicodeScalar(0xdfff), "accepted low surrogate scalar");
  const std::string original = u8"OpenFinalShell 中文 \U0001F680";
  std::vector<std::uint8_t> utf16;
  std::string roundTrip;
  ok = expect(ofs::rdp::utf8ToUtf16Le(original, utf16), "valid UTF-8 conversion failed") &&
            expect(ofs::rdp::utf16LeToUtf8(utf16.data(), utf16.size(), roundTrip),
                   "valid UTF-16 conversion failed") &&
            expect(roundTrip == original, "Unicode round trip changed text");

  ok = expect(rejectsUtf8(std::string("\x80", 1)), "accepted stray continuation") && ok;
  ok = expect(rejectsUtf8(std::string("\xc0\xaf", 2)), "accepted two-byte overlong form") && ok;
  ok = expect(rejectsUtf8(std::string("\xe0\x80\xaf", 3)), "accepted three-byte overlong form") && ok;
  ok = expect(rejectsUtf8(std::string("\xed\xa0\x80", 3)), "accepted UTF-8 surrogate") && ok;
  ok = expect(rejectsUtf8(std::string("\xf4\x90\x80\x80", 4)), "accepted code point above U+10FFFF") && ok;
  ok = expect(rejectsUtf8(std::string("\xe4\xb8", 2)), "accepted truncated UTF-8") && ok;
  ok = expect(rejectsUtf8(std::string("\xe4\x41\xad", 3)), "accepted invalid continuation") && ok;

  const std::string scalarBoundaries = u8"\U00010000\U0010ffff";
  std::vector<std::uint8_t> boundaryUtf16;
  std::string boundaryRoundTrip;
  ok = expect(ofs::rdp::utf8ToUtf16Le(scalarBoundaries, boundaryUtf16),
              "Unicode supplementary boundaries conversion failed") &&
       expect(boundaryUtf16.size() == 10 && boundaryUtf16[0] == 0x00 &&
                  boundaryUtf16[1] == 0xd8 && boundaryUtf16[2] == 0x00 &&
                  boundaryUtf16[3] == 0xdc && boundaryUtf16[4] == 0xff &&
                  boundaryUtf16[5] == 0xdb && boundaryUtf16[6] == 0xff &&
                  boundaryUtf16[7] == 0xdf,
              "Unicode supplementary boundaries produced wrong UTF-16") &&
       expect(ofs::rdp::utf16LeToUtf8(boundaryUtf16.data(), boundaryUtf16.size(),
                                      boundaryRoundTrip) &&
                  boundaryRoundTrip == scalarBoundaries,
              "Unicode supplementary boundaries round trip changed text") &&
       ok;

  ok = expect(rejectsUtf16({0x00, 0xd8}), "accepted isolated UTF-16 high surrogate") && ok;
  ok = expect(rejectsUtf16({0x00, 0xdc}), "accepted isolated UTF-16 low surrogate") && ok;
  ok = expect(rejectsUtf16({0x00, 0xd8, 0x41, 0x00}), "accepted malformed surrogate pair") && ok;
  ok = expect(rejectsUtf16({0x41}), "accepted odd-length UTF-16") && ok;
  return ok ? 0 : 1;
}
