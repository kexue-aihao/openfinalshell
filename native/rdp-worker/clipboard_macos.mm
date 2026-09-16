#include "clipboard_platform.h"
#import <AppKit/AppKit.h>
#include <atomic>
#include <future>
#include <mutex>
#include <thread>

namespace ofs::rdp {
namespace {
std::atomic_bool available{false};
std::mutex listenerMutex;
LocalClipboardMonitor::Listener changeListener;
NSInteger ownedSequence = -1;
template<class F> auto onUi(F fn) -> decltype(fn()) {
  using Result = decltype(fn());
  if (!available) return Result{};
  if ([NSThread isMainThread]) return fn();
  auto task = std::make_shared<std::packaged_task<Result()>>(std::move(fn));
  auto result = task->get_future();
  dispatch_async(dispatch_get_main_queue(), ^{ @autoreleasepool { (*task)(); } });
  return result.get();
}
}
int runClipboardEventLoop(std::function<int()> worker) {
  @autoreleasepool {
    available = [NSPasteboard generalPasteboard] != nil;
    __block NSInteger previous = [[NSPasteboard generalPasteboard] changeCount];
    NSTimer* timer = [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer*) {
      const auto current = [[NSPasteboard generalPasteboard] changeCount];
      if (current == previous) return;
      previous = current;
      std::lock_guard<std::mutex> lock(listenerMutex);
      if (changeListener) changeListener();
    }];
    std::atomic_bool finished{false};
    int result = 0;
    std::thread protocol([&] { result = worker(); finished = true; });
    while (!finished) {
      @autoreleasepool {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
      }
    }
    protocol.join();
    [timer invalidate];
    available = false;
    return result;
  }
}
bool nativeClipboardAvailable() { return available; }
std::uint32_t localClipboardSequence() {
  return onUi([] { return static_cast<std::uint32_t>([[NSPasteboard generalPasteboard] changeCount]) + 1u; });
}
bool localClipboardHasFiles() {
  return onUi([] {
    return [[NSPasteboard generalPasteboard] canReadObjectForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}] == YES;
  });
}
std::vector<std::string> localClipboardFiles() {
  return onUi([] {
    std::vector<std::string> paths;
    NSArray* urls = [[NSPasteboard generalPasteboard] readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
    if (urls.count > 64) return paths;
    for (NSURL* url in urls) {
      if (!url.isFileURL || (url.host.length && ![url.host isEqualToString:@"localhost"])) { paths.clear(); return paths; }
      const char* path = url.path.UTF8String;
      if (!path || !*path) { paths.clear(); return paths; }
      paths.emplace_back(path);
    }
    return paths;
  });
}
std::string readLocalClipboardText() {
  return onUi([] {
    NSString* value = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    const char* bytes = value.UTF8String;
    std::string text = bytes ? bytes : "";
    if (text.size() > 4u * 1024u * 1024u) text.clear();
    return text;
  });
}
std::uint32_t writeLocalClipboardText(const std::string& text) {
  if (text.size() > 4u * 1024u * 1024u) return 0;
  return onUi([&] {
    NSPasteboard* board = [NSPasteboard generalPasteboard];
    if (ownedSequence >= 0 && board.changeCount == ownedSequence) return std::uint32_t(0);
    NSString* value = [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
    if (!value) return std::uint32_t(0);
    [board clearContents];
    if (![board setString:value forType:NSPasteboardTypeString]) return std::uint32_t(0);
    return static_cast<std::uint32_t>(board.changeCount) + 1u;
  });
}
std::uint32_t publishLocalFileUrls(const std::vector<std::string>& paths,
                                 std::uint32_t expectedSequence,
                                 const std::function<bool()>& valid) {
  return onUi([&] {
    NSMutableArray<NSURL*>* urls = [NSMutableArray arrayWithCapacity:paths.size()];
    for (const auto& path : paths) {
      NSString* value = [[NSString alloc] initWithBytes:path.data() length:path.size() encoding:NSUTF8StringEncoding];
      if (!value) return std::uint32_t(0);
      [urls addObject:[NSURL fileURLWithPath:value]];
    }
    if (!urls.count) return std::uint32_t(0);
    NSPasteboard* board = [NSPasteboard generalPasteboard];
    if (static_cast<std::uint32_t>(board.changeCount) + 1u != expectedSequence || !valid()) return std::uint32_t(0);
    [board clearContents];
    if (![board writeObjects:urls]) return std::uint32_t(0);
    ownedSequence = board.changeCount;
    return static_cast<std::uint32_t>(ownedSequence) + 1u;
  });
}
void clearOwnedLocalClipboard(std::uint32_t token) {
  onUi([=] {
    NSPasteboard* board = [NSPasteboard generalPasteboard];
    if (token && ownedSequence >= 0 && token == static_cast<std::uint32_t>(ownedSequence) + 1u && board.changeCount == ownedSequence) [board clearContents];
    return true;
  });
}
bool ownsLocalFileClipboard(std::uint32_t token) {
  return onUi([=] { return token && ownedSequence >= 0 && token == static_cast<std::uint32_t>(ownedSequence) + 1u && [[NSPasteboard generalPasteboard] changeCount] == ownedSequence; });
}
struct LocalClipboardMonitor::Impl {};
LocalClipboardMonitor::LocalClipboardMonitor() : impl(std::make_unique<Impl>()) {}
LocalClipboardMonitor::~LocalClipboardMonitor() { stop(); }
void LocalClipboardMonitor::start(Listener listener) { std::lock_guard<std::mutex> lock(listenerMutex); changeListener = std::move(listener); }
void LocalClipboardMonitor::stop() { std::lock_guard<std::mutex> lock(listenerMutex); changeListener = {}; }
}
