#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>
#include <string>
namespace ofs::rdp {
// The platform event loop owns AppKit/GTK access; protocol input and FreeRDP
// continue on their own threads. Headless/self-test mode does not start it.
int runClipboardEventLoop(std::function<int()> worker);
bool nativeClipboardAvailable();
std::uint32_t localClipboardSequence();
bool localClipboardHasFiles();
std::vector<std::string> localClipboardFiles();
// Accepts a single relative file/folder name as received from a remote desktop
// FileGroupDescriptorW payload. Rejects absolute paths, drive letters, "..",
// empty or trailing-dot/space segments and characters Windows cannot store.
// Every segment of a multi-level remote path must pass this check before the
// name is written to a local download directory.
bool clipboardFileNameSafeUtf8(const char* name, std::size_t length);
// Best-effort local system clipboard text as UTF-8. Empty when unavailable or
// when the clipboard holds no readable text.
std::string readLocalClipboardText();
// Replaces the local system clipboard text with UTF-8 content. Returns the
// clipboard sequence number right after a successful write (so callers can
// recognize their own echo), or 0 on failure.
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
// Windows uses OLE delayed rendering. Unix materializes a bounded selection
// before publishing file URLs; no partially downloaded path is exposed.
class FileClipboard {
 public:
  using Reader = std::function<bool(std::uint32_t, std::uint64_t, std::uint32_t,
                                    std::vector<std::uint8_t>&)>;
  using Progress = std::function<void(const char*, std::uint32_t, std::uint64_t, std::uint64_t)>;
  FileClipboard();
  ~FileClipboard();
  bool publish(std::vector<std::uint8_t> descriptors, Reader reader, Progress progress = {});
  void clear();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
}
