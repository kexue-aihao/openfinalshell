#include "clipboard_platform.h"
#include "rdp_clipboard_core.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <fstream>
#include <mutex>
#include <thread>

namespace {
std::mutex mutex;
std::vector<std::string> published;
std::atomic_uint32_t sequence{1};
std::atomic_uint32_t owner{0};
std::atomic_bool replaceBeforePublish{false};
template<class Check> void waitFor(Check check) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!check()) {
    assert(std::chrono::steady_clock::now() < end);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}
}
namespace ofs::rdp {
bool nativeClipboardAvailable() { return true; }
std::uint32_t localClipboardSequence() { return sequence; }
std::uint32_t publishLocalFileUrls(const std::vector<std::string>& paths,
                                 std::uint32_t expectedSequence,
                                 const std::function<bool()>& valid) {
  std::lock_guard<std::mutex> guard(mutex);
  if (replaceBeforePublish.exchange(false)) ++sequence;
  if (sequence != expectedSequence || !valid()) return 0;
  published = paths; owner = ++sequence; return owner;
}
void clearOwnedLocalClipboard(std::uint32_t token) {
  std::lock_guard<std::mutex> guard(mutex);
  if (owner == token) { owner = 0; published.clear(); ++sequence; }
}
bool ownsLocalFileClipboard(std::uint32_t token) { return owner == token; }
}
int main() {
  using namespace ofs::rdp;
  FileClipboard clipboard;
  std::vector<std::uint8_t> descriptors;
  assert(encodeFileDescriptors({{"folder", 0, true}, {"folder\\hello.txt", 5, false}, {"empty", 0, true}}, descriptors));
  std::atomic_bool completed{false};
  std::atomic_uint32_t reads{0};
  assert(clipboard.publish(descriptors, [&](auto index, auto offset, auto count, auto& bytes) {
    assert(index == 1 && offset == 0 && count == 5);
    // Native file URLs must not be observable until the whole selection is ready.
    assert(owner == 0); ++reads;
    bytes = {'h','e','l','l','o'}; return true;
  }, [&](const char* state, auto...) { if (std::string(state) == "completed") completed = true; }));
  waitFor([&] { return completed.load(); });
  assert(reads == 1 && owner != 0);
  std::filesystem::path root;
  { std::lock_guard<std::mutex> guard(mutex);
    assert(published.size() == 2);
    for (const auto& path : published) if (std::filesystem::path(path).filename() == "folder") root = path;
  }
  assert(!root.empty());
  { std::ifstream input(root / "hello.txt"); std::string text; input >> text; assert(text == "hello"); }
  clipboard.clear();
  waitFor([&] { return owner == 0 && !std::filesystem::exists(root); });
  completed = false;
  std::atomic_bool failed{false};
  assert(clipboard.publish(descriptors, [](auto, auto, auto, auto&) { return false; },
      [&](const char* state, auto...) { if (std::string(state) == "failed") failed = true; }));
  waitFor([&] { return failed.load(); });
  assert(owner == 0);
  // Simulate a local user copy after the cache's pre-publication check but
  // before its queued call runs on the owning UI thread.
  failed = false;
  replaceBeforePublish = true;
  assert(clipboard.publish(descriptors, [](auto, auto, auto, auto& bytes) {
    bytes = {'h','e','l','l','o'}; return true;
  }, [&](const char* state, auto...) { if (std::string(state) == "failed") failed = true; }));
  waitFor([&] { return failed.load(); });
  assert(owner == 0);
  // A new local clipboard selection while a transfer is running prevents
  // publishing stale files even when the remote chunk itself succeeded.
  failed = false;
  assert(clipboard.publish(descriptors, [&](auto, auto, auto, auto& bytes) {
    ++sequence; bytes = {'h','e','l','l','o'}; return true;
  }, [&](const char* state, auto...) { if (std::string(state) == "failed") failed = true; }));
  waitFor([&] { return failed.load(); });
  assert(owner == 0);
  clipboard.clear();

  std::atomic_bool entered{false}, releaseRead{false}, oldCanceled{false}, replacementFailed{false};
  assert(clipboard.publish(descriptors, [&](auto, auto, auto, auto& bytes) {
    entered = true;
    waitFor([&] { return releaseRead.load(); });
    bytes = {'h','e','l','l','o'}; return true;
  }, [&](const char* state, auto...) { if (std::string(state) == "canceled") oldCanceled = true; }));
  waitFor([&] { return entered.load(); });
  assert(clipboard.publish(descriptors, [](auto, auto, auto, auto& bytes) {
    bytes = {'h','e','l','l','o'}; return true;
  }, [&](const char* state, auto...) { if (std::string(state) == "failed") replacementFailed = true; }));
  ++sequence; // user copies something while the replacement is still queued
  releaseRead = true;
  waitFor([&] { return oldCanceled.load() && replacementFailed.load(); });
  assert(owner == 0);
  clipboard.clear();
}
