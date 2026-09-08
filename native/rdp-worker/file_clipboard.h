#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>
#include <string>
namespace ofs::rdp {
std::vector<std::string> localClipboardFiles();
// Best-effort local system clipboard text (CF_UNICODETEXT) as UTF-8. Empty on
// non-Windows or when the clipboard holds no readable text.
std::string readLocalClipboardText();
// Replaces the local system clipboard text with UTF-8 content. Returns the
// clipboard sequence number right after a successful write (so callers can
// recognize their own echo), or 0 on failure / non-Windows.
std::uint32_t writeLocalClipboardText(const std::string& utf8);
// Watches the local system clipboard and invokes the listener (on its own
// thread) after every change. Used for automatic local->remote mirroring;
// the listener must only enqueue work, never call FreeRDP directly.
class LocalClipboardMonitor {
 public:
  using Listener = std::function<void()>;
  LocalClipboardMonitor();
  ~LocalClipboardMonitor();
  void start(Listener listener);
  void stop();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
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
