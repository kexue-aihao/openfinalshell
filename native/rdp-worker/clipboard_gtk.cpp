#include "clipboard_platform.h"
#include <gtk/gtk.h>
#include <atomic>
#include <future>
#include <mutex>
#include <thread>
#include <type_traits>

namespace ofs::rdp {
namespace {
std::atomic_bool available{false};
std::atomic_uint32_t sequence{1};
std::thread::id uiThread;
std::mutex listenerMutex;
LocalClipboardMonitor::Listener changeListener;
GtkClipboard* clipboard = nullptr;
void enqueueUi(GSourceFunc callback, gpointer data) {
  // g_main_context_invoke may execute inline when the caller can acquire the
  // context. A source always runs from GTK's owning main loop instead.
  GSource* source = g_idle_source_new();
  g_source_set_callback(source, callback, data, nullptr);
  g_source_attach(source, g_main_context_default());
  g_source_unref(source);
}

template<class F> auto onUi(F fn) -> decltype(fn()) {
  using Result = decltype(fn());
  if (!available) return Result{};
  if (std::this_thread::get_id() == uiThread) return fn();
  auto* task = new std::packaged_task<Result()>(std::move(fn));
  auto result = task->get_future();
  enqueueUi([](gpointer data) -> gboolean {
    std::unique_ptr<std::packaged_task<Result()>> work(static_cast<std::packaged_task<Result()>*>(data));
    (*work)();
    return G_SOURCE_REMOVE;
  }, task);
  return result.get();
}

struct Files { std::vector<std::string> urls; std::uint32_t owner = 0; };
Files* owned = nullptr;
void getFiles(GtkClipboard*, GtkSelectionData* data, guint type, gpointer userData) {
  auto* files = static_cast<Files*>(userData);
  if (type == 0) {
    std::vector<gchar*> urls;
    for (auto& url : files->urls) urls.push_back(const_cast<gchar*>(url.c_str()));
    urls.push_back(nullptr);
    gtk_selection_data_set_uris(data, urls.data());
  } else {
    std::string text = type == 1 ? "copy\n" : "0";
    if (type == 1) for (std::size_t i = 0; i < files->urls.size(); ++i) {
      if (i) text += '\n';
      text += files->urls[i];
    }
    gtk_selection_data_set(data, gtk_selection_data_get_target(data), 8,
        reinterpret_cast<const guchar*>(text.data()), static_cast<gint>(text.size()));
  }
}
void releaseFiles(GtkClipboard*, gpointer userData) {
  auto* files = static_cast<Files*>(userData);
  if (owned == files) owned = nullptr;
  delete files;
}
}

int runClipboardEventLoop(std::function<int()> worker) {
  uiThread = std::this_thread::get_id();
  if (!gtk_init_check(nullptr, nullptr)) return worker();
  clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  available = clipboard != nullptr;
  if (!available) return worker();
  const auto handler = g_signal_connect(clipboard, "owner-change", G_CALLBACK(+[](GtkClipboard*, GdkEventOwnerChange*, gpointer) {
    ++sequence;
    std::lock_guard<std::mutex> lock(listenerMutex);
    if (changeListener) changeListener();
  }), nullptr);
  int result = 0;
  std::thread protocol([&] {
    result = worker();
    // Scheduled on main context, after worker destruction has released all
    // outstanding provider calls. No UI call may be queued after quit.
    enqueueUi([](gpointer) -> gboolean { gtk_main_quit(); return G_SOURCE_REMOVE; }, nullptr);
  });
  gtk_main();
  protocol.join();
  g_signal_handler_disconnect(clipboard, handler);
  available = false;
  return result;
}
bool nativeClipboardAvailable() { return available; }
std::uint32_t localClipboardSequence() { return sequence; }
bool localClipboardHasFiles() {
  return onUi([] {
    return gtk_clipboard_wait_is_target_available(clipboard, gdk_atom_intern_static_string("text/uri-list")) != FALSE;
  });
}
std::vector<std::string> localClipboardFiles() {
  return onUi([] {
    std::vector<std::string> paths;
    gchar** urls = gtk_clipboard_wait_for_uris(clipboard);
    if (!urls) return paths;
    for (std::size_t i = 0; urls[i]; ++i) {
      if (i >= 64) { paths.clear(); break; }
      gchar* hostname = nullptr;
      gchar* path = g_filename_from_uri(urls[i], &hostname, nullptr);
      const bool local = !hostname || !*hostname || g_ascii_strcasecmp(hostname, "localhost") == 0;
      if (!path || !local) { g_free(path); g_free(hostname); paths.clear(); break; }
      gchar* utf8 = g_filename_to_utf8(path, -1, nullptr, nullptr, nullptr);
      const bool converted = utf8 != nullptr;
      if (utf8) paths.emplace_back(utf8);
      g_free(path); g_free(hostname); g_free(utf8);
      if (!converted) { paths.clear(); break; }
    }
    g_strfreev(urls);
    return paths;
  });
}
std::string readLocalClipboardText() {
  return onUi([] {
    gchar* value = gtk_clipboard_wait_for_text(clipboard);
    std::string text = value ? value : "";
    g_free(value);
    if (text.size() > 4u * 1024u * 1024u) text.clear();
    return text;
  });
}
std::uint32_t writeLocalClipboardText(const std::string& text) {
  if (text.size() > 4u * 1024u * 1024u) return 0;
  return onUi([&] {
    if (owned) return std::uint32_t(0);
    gtk_clipboard_set_text(clipboard, text.data(), static_cast<gint>(text.size()));
    return ++sequence;
  });
}
std::uint32_t publishLocalFileUrls(const std::vector<std::string>& paths,
                                 std::uint32_t expectedSequence,
                                 const std::function<bool()>& valid) {
  return onUi([&] {
    auto files = std::make_unique<Files>();
    for (const auto& path : paths) {
      gchar* filename = g_filename_from_utf8(path.c_str(), -1, nullptr, nullptr, nullptr);
      gchar* uri = filename ? g_filename_to_uri(filename, nullptr, nullptr) : nullptr;
      g_free(filename);
      if (!uri) return std::uint32_t(0);
      files->urls.emplace_back(uri); g_free(uri);
    }
    if (files->urls.empty()) return std::uint32_t(0);
    GtkTargetEntry targets[] = {
      {const_cast<gchar*>("text/uri-list"), 0, 0},
      {const_cast<gchar*>("x-special/gnome-copied-files"), 0, 1},
      {const_cast<gchar*>("application/x-kde-cutselection"), 0, 2}
    };
    // Check on the GTK thread immediately before replacing ownership. A
    // clipboard change while this call was queued must win over this task.
    if (sequence != expectedSequence || !valid()) return std::uint32_t(0);
    if (!gtk_clipboard_set_with_data(clipboard, targets, 3, getFiles, releaseFiles, files.get())) return std::uint32_t(0);
    owned = files.release();
    owned->owner = ++sequence;
    return owned->owner;
  });
}
void clearOwnedLocalClipboard(std::uint32_t token) {
  onUi([=] {
    if (owned && owned->owner == token) gtk_clipboard_clear(clipboard);
    return true;
  });
}
bool ownsLocalFileClipboard(std::uint32_t token) { return onUi([=] { return owned && owned->owner == token; }); }
struct LocalClipboardMonitor::Impl {};
LocalClipboardMonitor::LocalClipboardMonitor() : impl(std::make_unique<Impl>()) {}
LocalClipboardMonitor::~LocalClipboardMonitor() { stop(); }
void LocalClipboardMonitor::start(Listener listener) { std::lock_guard<std::mutex> lock(listenerMutex); changeListener = std::move(listener); }
void LocalClipboardMonitor::stop() { std::lock_guard<std::mutex> lock(listenerMutex); changeListener = {}; }
}
