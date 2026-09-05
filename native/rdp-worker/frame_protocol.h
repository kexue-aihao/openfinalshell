#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

namespace ofs::rdp::frame {

constexpr std::uint32_t kMaxPayload = 64u * 1024u * 1024u;
constexpr std::uint32_t kFrameHeaderSize = 16u;
constexpr std::uint32_t kRectHeaderSize = 24u;
constexpr std::uint32_t kMaxFrameRects = 1024u;
constexpr std::uint64_t kMaxDisplayPixels = 16777216u;

inline bool validCanvas(std::uint32_t width, std::uint32_t height) {
  return width >= 320u && height >= 320u && width <= 8192u && height <= 8192u &&
         static_cast<std::uint64_t>(width) * height <= kMaxDisplayPixels;
}

inline bool validRect(std::uint32_t canvasWidth, std::uint32_t canvasHeight,
                      std::int32_t x, std::int32_t y, std::uint32_t width,
                      std::uint32_t height, std::uint32_t stride,
                      std::size_t pixelBytes, std::uint64_t currentPayload) {
  if (!validCanvas(canvasWidth, canvasHeight) || x < 0 || y < 0 || width == 0 || height == 0 ||
      static_cast<std::uint64_t>(x) + width > canvasWidth ||
      static_cast<std::uint64_t>(y) + height > canvasHeight || stride == 0 ||
      static_cast<std::uint64_t>(width) * 4u > stride ||
      static_cast<std::uint64_t>(stride) * height != static_cast<std::uint64_t>(pixelBytes) ||
      pixelBytes > std::numeric_limits<std::uint32_t>::max())
    return false;

  const auto bytes = static_cast<std::uint64_t>(pixelBytes);
  if (bytes > kMaxPayload - kRectHeaderSize || currentPayload > kMaxPayload ||
      currentPayload > kMaxPayload - kRectHeaderSize - bytes)
    return false;
  return true;
}

}  // namespace ofs::rdp::frame
