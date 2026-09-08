#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>
#include <string>
namespace ofs::rdp {
std::vector<std::string> localClipboardFiles();
// Native delayed rendering: metadata at copy time, content requested by Explorer at paste time.
class FileClipboard {
 public:
  using Reader = std::function<bool(std::uint32_t, std::uint64_t, std::uint32_t,
                                    std::vector<std::uint8_t>&)>;
  FileClipboard();
  ~FileClipboard();
  void publish(std::vector<std::uint8_t> descriptors, Reader reader);
  void clear();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
}
