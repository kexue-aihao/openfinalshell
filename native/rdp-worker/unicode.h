#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace ofs::rdp {

bool isUnicodeScalar(std::uint32_t value);

bool utf8ToUtf16Le(std::string_view input, std::vector<std::uint8_t>& output,
                   bool appendNull = true);
bool utf16LeToUtf8(const std::uint8_t* input, std::size_t length, std::string& output,
                   bool stopAtNull = true);

}  // namespace ofs::rdp
