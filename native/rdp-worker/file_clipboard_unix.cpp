#include "clipboard_platform.h"
#include "rdp_clipboard_core.h"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <iterator>
#include <mutex>
#include <set>
#include <thread>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ofs::rdp {
namespace {
class FileHandle {
  int value = -1;
 public:
  explicit FileHandle(int fd = -1) : value(fd) {}
  ~FileHandle() { if (value >= 0) close(value); }
  FileHandle(const FileHandle&) = delete;
  FileHandle& operator=(const FileHandle&) = delete;
  int get() const { return value; }
  bool finish() { const auto fd = value; value = -1; return fd < 0 || close(fd) == 0; }
  void reset(int fd) { if (value >= 0) close(value); value = fd; }
};
struct Selection {
  std::vector<RdpFileEntry> files;
  FileClipboard::Reader reader;
  FileClipboard::Progress progress;
  std::uint32_t initialSequence = 0;
  std::atomic_bool valid{true};
};
// An advisory lock protects live workers from orphan cleanup, including PID
// reuse. Never follow symlinks or remove a directory owned by another user.
class Cache {
  int lock = -1;
  FileHandle root;
 public:
  std::filesystem::path path;
  Cache() {
    const auto base = std::filesystem::temp_directory_path();
    const auto prefix = "ofs-rdp-cache-" + std::to_string(getuid()) + "-";
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(base, ec)) {
      if (entry.path().filename().string().rfind(prefix, 0) != 0) continue;
      struct stat info{};
      if (lstat(entry.path().c_str(), &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid()) continue;
      // A new worker may be between mkdir and taking its lock. Do not race
      // startup; only an older, unlocked cache can be an orphan.
      if (std::time(nullptr) - info.st_mtime < 60) continue;
      const auto marker = entry.path() / ".owner";
      const int fd = open(marker.c_str(), O_RDWR | O_NOFOLLOW | O_CLOEXEC);
      if (fd < 0) continue;
      if (flock(fd, LOCK_EX | LOCK_NB) == 0) std::filesystem::remove_all(entry.path(), ec);
      close(fd);
    }
    auto pattern = (base / (prefix + std::to_string(getpid()) + "-XXXXXX")).string();
    std::vector<char> name(pattern.begin(), pattern.end()); name.push_back(0);
    if (!mkdtemp(name.data())) return;
    path = name.data();
    lock = open((path / ".owner").c_str(), O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) { if (lock >= 0) close(lock); lock = -1; std::filesystem::remove_all(path, ec); path.clear(); }
    else root.reset(open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  }
  // Resolve every child from an already-open private directory. O_NOFOLLOW
  // only on the final file would still traverse a symlink in a parent.
  int create(const RdpFileEntry& entry) {
    if (root.get() < 0 || !safeRelativePath(entry.relativePath)) return -1;
    auto relative = std::filesystem::path("files") / relativeFilePath(entry.relativePath);
    FileHandle parent(dup(root.get()));
    if (parent.get() < 0) return -1;
    for (auto component = relative.begin(); component != relative.end(); ++component) {
      const auto name = component->string();
      const bool last = std::next(component) == relative.end();
      if (last && !entry.directory)
        return openat(parent.get(), name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (mkdirat(parent.get(), name.c_str(), 0700) && errno != EEXIST) return -1;
      const int next = openat(parent.get(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) return -1;
      parent.reset(next);
    }
    return -2; // directory successfully created
  }
  ~Cache() {
    std::error_code ec;
    if (!path.empty()) std::filesystem::remove_all(path, ec);
    if (lock >= 0) close(lock);
  }
};
}
bool clipboardFileNameSafeUtf8(const char* name, std::size_t length) {
  return name && safeRelativePath(std::string_view(name, length));
}
struct FileClipboard::Impl {
  std::mutex mutex;
  std::condition_variable cv;
  std::shared_ptr<Selection> pending;
  std::shared_ptr<Selection> current;
  std::uint32_t publishedOwner = 0;
  std::atomic_bool stop{false};
  std::thread thread;
  Impl() : thread([this] { run(); }) {}
  ~Impl() { stop = true; cv.notify_all(); thread.join(); }

  void materialize(const std::shared_ptr<Selection>& job) {
    std::uint64_t total = 0, transferred = 0;
    for (const auto& entry : job->files) total += entry.size;
    const auto initialSequence = job->initialSequence;
    auto valid = [&] { return !stop && job->valid && initialSequence == localClipboardSequence(); };
    auto progress = [&](const char* state, std::uint32_t index) {
      if (job->progress) job->progress(state, index, transferred, total);
    };
    Cache cache;
    std::error_code ec;
    bool ok = !cache.path.empty();
    if (ok) {
      auto space = std::filesystem::space(cache.path, ec);
      ok = !ec && space.available >= total;
    }
    progress("preparing", 0);
    std::set<std::string> roots;
    std::uint32_t index = 0;
    for (; ok && index < job->files.size(); ++index) {
      const auto& entry = job->files[index];
      if (!valid()) { ok = false; break; }
      auto relative = relativeFilePath(entry.relativePath);
      roots.insert(relative.begin()->u8string());
      const auto created = cache.create(entry);
      if (created == -1) { ok = false; break; }
      if (created == -2) continue;
      FileHandle output(created);
      std::uint64_t offset = 0;
      while (ok && offset < entry.size) {
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(1024 * 1024, entry.size - offset));
        std::vector<std::uint8_t> bytes;
        if (!valid() || !job->reader(index, offset, count, bytes) || !valid() || bytes.size() != count) { ok = false; break; }
        std::size_t written = 0;
        while (written < bytes.size()) {
          const auto n = write(output.get(), bytes.data() + written, bytes.size() - written);
          if (n < 0 && errno == EINTR) continue;
          if (n <= 0) { ok = false; break; }
          written += static_cast<std::size_t>(n);
        }
        offset += written; transferred += written;
        progress("transferring", index + 1);
      }
      struct stat info{};
      if (fstat(output.get(), &info) || static_cast<std::uint64_t>(info.st_size) != entry.size) ok = false;
      if (!output.finish()) ok = false;
    }
    std::uint32_t owner = 0;
    if (ok && valid()) {
      std::vector<std::string> paths;
      for (const auto& root : roots) paths.push_back((cache.path / "files" / std::filesystem::u8path(root)).u8string());
      // Serialize the ownership handoff with clear(). Otherwise an old job
      // could publish after cancellation had already cleared its owner token.
      std::lock_guard<std::mutex> guard(mutex);
      owner = publishLocalFileUrls(paths, initialSequence, [&] { return !stop && job->valid; });
      publishedOwner = owner;
    }
    if (!owner || !job->valid) {
      if (owner) clearOwnedLocalClipboard(owner);
      progress(job->valid && !stop ? "failed" : "canceled", index);
      return;
    }
    progress("completed", static_cast<std::uint32_t>(job->files.size()));
    // Keep materialized files only while this exact selection is still owned.
    while (!stop && job->valid && ownsLocalFileClipboard(owner)) {
      std::unique_lock<std::mutex> guard(mutex);
      cv.wait_for(guard, std::chrono::milliseconds(100));
    }
    clearOwnedLocalClipboard(owner);
    { std::lock_guard<std::mutex> guard(mutex); if (publishedOwner == owner) publishedOwner = 0; }
  }
  void run() {
    while (!stop) {
      std::shared_ptr<Selection> job;
      {
        std::unique_lock<std::mutex> guard(mutex);
        cv.wait(guard, [&] { return stop || pending; });
        if (stop) break;
        job = std::move(pending); current = job;
      }
      try { materialize(job); }
      catch (...) { if (job->progress) job->progress("failed", 0, 0, 0); }
      std::lock_guard<std::mutex> guard(mutex);
      if (current == job) current.reset();
    }
  }
};
FileClipboard::FileClipboard() : impl(std::make_unique<Impl>()) {}
FileClipboard::~FileClipboard() { clear(); }
void FileClipboard::clear() {
  std::uint32_t owner = 0;
  {
    std::lock_guard<std::mutex> guard(impl->mutex);
    if (impl->pending) impl->pending->valid = false;
    if (impl->current) impl->current->valid = false;
    impl->pending.reset();
    owner = impl->publishedOwner;
    impl->publishedOwner = 0;
  }
  if (owner) clearOwnedLocalClipboard(owner);
  impl->cv.notify_all();
}
bool FileClipboard::publish(std::vector<std::uint8_t> bytes, Reader reader, Progress progress) {
  clear();
  if (!reader || !nativeClipboardAvailable()) return false;
  auto job = std::make_shared<Selection>();
  if (!decodeFileDescriptors(bytes.data(), bytes.size(), job->files)) return false;
  job->reader = std::move(reader); job->progress = std::move(progress);
  // Snapshot at request time, not when a queued job eventually starts. A
  // user's new local clipboard selection while waiting must remain intact.
  job->initialSequence = localClipboardSequence();
  { std::lock_guard<std::mutex> guard(impl->mutex); impl->pending = std::move(job); }
  impl->cv.notify_all();
  return true;
}
}
