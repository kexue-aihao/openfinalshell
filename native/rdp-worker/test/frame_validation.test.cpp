#include "frame_protocol.h"

#include <cstdint>
#include <iostream>
#include <limits>

namespace {

bool expect(bool condition, const char* message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

}  // namespace

int main() {
  using namespace ofs::rdp::frame;
  constexpr std::uint64_t frameHeader = kFrameHeaderSize;

  bool ok = expect(validCanvas(1920, 1080), "accepted canvas is rejected") &&
            expect(!validCanvas(319, 1080), "canvas below minimum width accepted") &&
            expect(!validCanvas(4096, 4097), "canvas above pixel ceiling accepted") &&
            expect(validRect(1920, 1080, 10, 20, 100, 50, 400, 20000, frameHeader),
                   "valid dirty rectangle rejected") &&
            expect(!validRect(1920, 1080, -1, 20, 100, 50, 400, 20000, frameHeader),
                   "negative rectangle coordinate accepted") &&
            expect(!validRect(1920, 1080, 1900, 20, 100, 50, 400, 20000, frameHeader),
                   "out-of-bounds rectangle accepted") &&
            expect(!validRect(1920, 1080, 10, 20, 100, 50, 399, 20000, frameHeader),
                   "short stride accepted") &&
            expect(!validRect(1920, 1080, 10, 20, 100, 50, 400, 19999, frameHeader),
                   "stride/payload mismatch accepted") &&
            expect(!validRect(1920, 1080, 10, 20, 100, 50, 400, 20000,
                              kMaxPayload - kRectHeaderSize + 1),
                   "payload overflow accepted") &&
            expect(!validRect(1920, 1080, 10, 20, 100, 50, 400,
                              std::numeric_limits<std::uint32_t>::max() + std::size_t{1},
                              frameHeader),
                   "oversized rectangle payload accepted");
  return ok ? 0 : 1;
}
