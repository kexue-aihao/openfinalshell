#include "file_clipboard.h"
#if defined(_WIN32)
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <atomic>
#include <algorithm>
#include <cstring>
#include <future>
#include <mutex>
#include <thread>
#include <chrono>
#include <string>
#include <iostream>

#include "unicode.h"

namespace ofs::rdp {
namespace {

std::string wideToUtf8(const WCHAR* value, int length) {
  if (length <= 0) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length,
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string text(size, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length,
                      text.data(), size, nullptr, nullptr);
  return text;
}

}  // namespace

std::vector<std::string> localClipboardFiles() {
  std::vector<std::string> paths;
  if (!OpenClipboard(nullptr)) return paths;
  const auto drop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
  if (drop) {
    const auto count = DragQueryFileW(drop, 0xffffffff, nullptr, 0);
    if (count <= 64) for (UINT i = 0; i < count; ++i) {
      const auto length = DragQueryFileW(drop, i, nullptr, 0);
      if (!length || length > 32767) { paths.clear(); break; }
      std::vector<WCHAR> path(length + 1);
      if (!DragQueryFileW(drop, i, path.data(), length + 1)) { paths.clear(); break; }
      const std::string text = wideToUtf8(path.data(), length);
      if (text.empty()) { paths.clear(); break; }
      paths.push_back(std::move(text));
    }
  }
  CloseClipboard(); return paths;
}

std::string readLocalClipboardText() {
  std::string text;
  if (!IsClipboardFormatAvailable(CF_UNICODETEXT) || !OpenClipboard(nullptr)) return text;
  const HANDLE handle = GetClipboardData(CF_UNICODETEXT);
  if (handle) {
    const auto* data = static_cast<const WCHAR*>(GlobalLock(handle));
    if (data) {
      const SIZE_T bytes = GlobalSize(handle);
      std::size_t chars = static_cast<std::size_t>(bytes / sizeof(WCHAR));
      while (chars > 0 && data[chars - 1] == 0) --chars;
      text = wideToUtf8(data, static_cast<int>(chars));
      GlobalUnlock(handle);
    }
  }
  CloseClipboard(); return text;
}

std::uint32_t writeLocalClipboardText(const std::string& utf8) {
  std::vector<std::uint8_t> utf16;
  if (!utf8ToUtf16Le(utf8, utf16, true) || utf16.empty()) return 0;
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, utf16.size());
  if (!memory) return 0;
  void* target = GlobalLock(memory);
  if (!target) { GlobalFree(memory); return 0; }
  std::memcpy(target, utf16.data(), utf16.size());
  GlobalUnlock(memory);
  // Try a few times: another application may briefly hold the clipboard open.
  // SetClipboardData takes ownership of the block only on success.
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (!OpenClipboard(nullptr)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }
    const bool emptied = EmptyClipboard();
    const bool set = emptied && SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
    CloseClipboard();
    if (set) return GetClipboardSequenceNumber();
    if (!emptied) std::this_thread::sleep_for(std::chrono::milliseconds(20));
    else break;  // Clipboard was cleared but the write failed; nothing to retry into.
  }
  GlobalFree(memory);
  return 0;
}

struct LocalClipboardMonitor::Impl {
  Listener listener;
  std::atomic_bool stop{false};
  std::thread thread;
  std::promise<HWND> ready;
  HWND window = nullptr;  // valid after start() returns

  void run(Listener next) {
    listener = std::move(next);
    WNDCLASSW wc{};
    wc.lpfnWndProc = &Impl::wndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"OFS_RDP_CLIPBOARD_MONITOR";
    RegisterClassW(&wc);
    // A message-only window receives clipboard notifications without showing
    // anything on the desktop or stealing focus.
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"ofs-rdp-clipboard",
                                0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
                                wc.hInstance, this);
    if (hwnd) SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    ready.set_value(hwnd);
    if (hwnd && AddClipboardFormatListener(hwnd)) {
      MSG message{};
      while (!stop.load() && GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      RemoveClipboardFormatListener(hwnd);
    }
    if (hwnd) DestroyWindow(hwnd);
  }

  static LRESULT CALLBACK wndProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_CLIPBOARDUPDATE) {
      auto* impl = reinterpret_cast<Impl*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
      if (impl && impl->listener) impl->listener();
      return 0;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
  }
};

LocalClipboardMonitor::LocalClipboardMonitor() : impl(std::make_unique<Impl>()) {}
LocalClipboardMonitor::~LocalClipboardMonitor() { stop(); }
void LocalClipboardMonitor::start(Listener listener) {
  if (impl->thread.joinable()) return;
  impl->stop = false;
  impl->thread = std::thread([this, next = std::move(listener)]() mutable {
    impl->run(std::move(next));
  });
  impl->window = impl->ready.get_future().get();
}
void LocalClipboardMonitor::stop() {
  impl->stop = true;
  if (impl->window) PostMessageW(impl->window, WM_QUIT, 0, 0);
  if (impl->thread.joinable()) impl->thread.join();
  impl->window = nullptr;
}
namespace {

struct Selection {
  std::vector<FILEDESCRIPTORW> files;
  FileClipboard::Reader read;
  std::atomic_bool valid{true};
};
bool safeName(const std::wstring& name) {
  if (name.empty() || name.front() == L'\\' || name.front() == L'/' ||
      name.find_first_of(L":/*?\"<>|") != std::wstring::npos) return false;
  size_t start = 0;
  while (start < name.size()) {
    auto end = name.find(L'\\', start);
    auto part = name.substr(start, end == std::wstring::npos ? end : end - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    for (auto ch : part) if (ch < 32) return false;
    auto stem = part.substr(0, part.find(L'.'));
    std::transform(stem.begin(), stem.end(), stem.begin(), [](wchar_t ch) {
      return ch >= L'a' && ch <= L'z' ? wchar_t(ch - L'a' + L'A') : ch;
    });
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        (stem.size() == 4 && (stem.substr(0, 3) == L"COM" || stem.substr(0, 3) == L"LPT") &&
         stem[3] >= L'1' && stem[3] <= L'9')) return false;
    if (end == std::wstring::npos) return true;
    start = end + 1;
  }
  return false;
}
class RemoteStream final : public IStream {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<Selection> selection;
  ULONG index;
  std::uint64_t position = 0;
  std::uint64_t size() const {
    const auto& f = selection->files[index];
    return (static_cast<std::uint64_t>(f.nFileSizeHigh) << 32) | f.nFileSizeLow;
  }
 public:
  RemoteStream(std::shared_ptr<Selection> s, ULONG i) : selection(std::move(s)), index(i) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == IID_IUnknown || id == IID_ISequentialStream || id == IID_IStream) {
      *out = static_cast<IStream*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { auto n = --refs; if (!n) delete this; return n; }
  HRESULT STDMETHODCALLTYPE Read(void* data, ULONG count, ULONG* actual) override {
    if (actual) *actual = 0;
    if (!data && count) return STG_E_INVALIDPOINTER;
    if (!selection->valid) return STG_E_REVERTED;
    ULONG done = 0;
    while (done < count && position < size()) {
      auto n = static_cast<ULONG>(std::min<std::uint64_t>({count - done, size() - position, 1024 * 1024}));
      std::vector<std::uint8_t> bytes;
      if (!selection->valid || !selection->read(index, position, n, bytes) ||
          !selection->valid || bytes.size() != n)
        return STG_E_READFAULT;
      std::memcpy(static_cast<BYTE*>(data) + done, bytes.data(), n);
      done += n; position += n;
      if (actual) *actual = done;
    }
    return done == count ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Write(const void*, ULONG, ULONG*) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER delta, DWORD origin, ULARGE_INTEGER* out) override {
    if (origin > STREAM_SEEK_END) return STG_E_INVALIDFUNCTION;
    const auto base = origin == STREAM_SEEK_SET ? 0 : origin == STREAM_SEEK_CUR ? position : size();
    if (delta.QuadPart < 0 && static_cast<std::uint64_t>(-(delta.QuadPart + 1)) + 1 > base) return STG_E_INVALIDFUNCTION;
    if (delta.QuadPart > 0 && base > UINT64_MAX - static_cast<std::uint64_t>(delta.QuadPart)) return STG_E_INVALIDFUNCTION;
    position = base + delta.QuadPart;
    if (out) out->QuadPart = position;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream* target, ULARGE_INTEGER count, ULARGE_INTEGER* read, ULARGE_INTEGER* written) override {
    if (!target) return E_POINTER;
    if (read) read->QuadPart = 0;
    if (written) written->QuadPart = 0;
    std::vector<BYTE> buffer(64 * 1024);
    while (count.QuadPart) {
      ULONG got = 0, put = 0;
      auto hr = Read(buffer.data(), static_cast<ULONG>(std::min<std::uint64_t>(buffer.size(), count.QuadPart)), &got);
      if (FAILED(hr)) return hr;
      if (read) read->QuadPart += got;
      auto whr = target->Write(buffer.data(), got, &put);
      if (written) written->QuadPart += put;
      if (FAILED(whr) || put != got) return STG_E_WRITEFAULT;
      count.QuadPart -= got;
      if (hr == S_FALSE || got == 0) return S_FALSE;
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG* out, DWORD) override {
    if (!out) return E_POINTER;
    *out = {}; out->type = STGTY_STREAM; out->cbSize.QuadPart = size(); out->grfMode = STGM_READ;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream** out) override {
    if (!out) return E_POINTER;
    auto* stream = new RemoteStream(selection, index); stream->position = position; *out = stream; return S_OK;
  }
};
class FileObject final : public IDataObject {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<Selection> selection;
  CLIPFORMAT descriptor = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"FileGroupDescriptorW"));
  CLIPFORMAT contents = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"FileContents"));
  CLIPFORMAT effect = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"Preferred DropEffect"));
 public:
  explicit FileObject(std::shared_ptr<Selection> s) : selection(std::move(s)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == IID_IUnknown || id == IID_IDataObject) { *out = static_cast<IDataObject*>(this); AddRef(); return S_OK; }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { auto n = --refs; if (!n) delete this; return n; }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* f) override {
    if (!f) return E_POINTER;
    if (!selection->valid) return DV_E_FORMATETC;
    if (f->dwAspect != DVASPECT_CONTENT) return DV_E_DVASPECT;
    if ((f->cfFormat == descriptor || f->cfFormat == effect) && (f->tymed & TYMED_HGLOBAL)) return S_OK;
    if (f->cfFormat == contents && (f->tymed & TYMED_ISTREAM))
      return f->lindex >= 0 && static_cast<size_t>(f->lindex) < selection->files.size() ? S_OK : DV_E_LINDEX;
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* f, STGMEDIUM* out) override {
    if (!out) return E_POINTER;
    *out = {};
    auto hr = QueryGetData(f); if (FAILED(hr)) return hr;
    if (f->cfFormat == contents) {
      out->tymed = TYMED_ISTREAM; out->pstm = new RemoteStream(selection, f->lindex); return S_OK;
    }
    const size_t length = f->cfFormat == effect ? sizeof(DWORD) : sizeof(UINT) + sizeof(FILEDESCRIPTORW) * selection->files.size();
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, length);
    if (!memory) return E_OUTOFMEMORY;
    auto* data = static_cast<BYTE*>(GlobalLock(memory));
    if (!data) { GlobalFree(memory); return E_OUTOFMEMORY; }
    if (f->cfFormat == effect) { DWORD copy = DROPEFFECT_COPY; std::memcpy(data, &copy, sizeof(copy)); }
    else {
      UINT count = static_cast<UINT>(selection->files.size()); std::memcpy(data, &count, sizeof(count));
      std::memcpy(data + sizeof(count), selection->files.data(), sizeof(FILEDESCRIPTORW) * count);
    }
    GlobalUnlock(memory); out->tymed = TYMED_HGLOBAL; out->hGlobal = memory; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return DATA_E_FORMATETC; }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* out) override { if (out) out->ptd = nullptr; return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC** out) override {
    if (direction != DATADIR_GET) return E_NOTIMPL;
    FORMATETC formats[] = {{descriptor, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL},
      {contents, nullptr, DVASPECT_CONTENT, 0, TYMED_ISTREAM}, {effect, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL}};
    return SHCreateStdEnumFmtEtc(3, formats, out);
  }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override { return OLE_E_ADVISENOTSUPPORTED; }
};
}

bool clipboardFileNameSafeUtf8(const char* name, std::size_t length) {
  if (name == nullptr || length == 0) return false;
  // Decode to UTF-16 so the same rules that protect OLE publishing apply.
  std::wstring wide;
  try {
    wide.resize(length);
  } catch (const std::bad_alloc&) {
    return false;
  }
  const int wideLength = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                             name, static_cast<int>(length),
                                             wide.data(), static_cast<int>(wide.size()));
  if (wideLength <= 0) return false;
  wide.resize(static_cast<std::size_t>(wideLength));
  return safeName(wide);
}

struct FileClipboard::Impl {
  std::mutex mutex;
  std::shared_ptr<Selection> selection;
  std::atomic_bool stop{false};
  std::thread thread;
  Impl() : thread([this] {
    if (FAILED(OleInitialize(nullptr))) return;
    std::shared_ptr<Selection> current;
    FileObject* object = nullptr;
    while (!stop) {
      std::shared_ptr<Selection> next;
      { std::lock_guard<std::mutex> lock(mutex); next = selection; }
      if (next != current) {
        if (object) { if (OleIsCurrentClipboard(object) == S_OK) OleSetClipboard(nullptr); object->Release(); object = nullptr; }
        current = next;
        if (current && current->valid) {
          object = new FileObject(current);
          HRESULT result = E_FAIL;
          for (int attempt = 0; attempt < 5 && current->valid && !stop; ++attempt) {
            result = OleSetClipboard(object);
            if (SUCCEEDED(result)) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
          }
          if (FAILED(result)) {
            current->valid = false;
            std::cerr << "[rdp-worker] OleSetClipboard failed: HRESULT=0x"
                      << std::hex << result << std::dec << '\n';
          }
        }
      }
      MSG msg;
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (object) { if (OleIsCurrentClipboard(object) == S_OK) OleSetClipboard(nullptr); object->Release(); }
    OleUninitialize();
  }) {}
  ~Impl() { stop = true; thread.join(); }
};
FileClipboard::FileClipboard() : impl(std::make_unique<Impl>()) {}
FileClipboard::~FileClipboard() { clear(); }
void FileClipboard::clear() {
  std::lock_guard<std::mutex> lock(impl->mutex);
  if (impl->selection) impl->selection->valid = false;
  impl->selection.reset();
}
bool FileClipboard::publish(std::vector<std::uint8_t> bytes, Reader reader) {
  static_assert(sizeof(FILEDESCRIPTORW) == 592);
  clear();
  if (bytes.size() < 4 || !reader) return false;
  UINT count; std::memcpy(&count, bytes.data(), 4);
  if (count == 0 || count > 64 || bytes.size() != 4 + size_t(count) * sizeof(FILEDESCRIPTORW)) return false;
  auto s = std::make_shared<Selection>(); s->files.resize(count); s->read = std::move(reader);
  std::memcpy(s->files.data(), bytes.data() + 4, count * sizeof(FILEDESCRIPTORW));
  std::uint64_t total = 0;
  for (auto& f : s->files) {
    if (std::find(std::begin(f.cFileName), std::end(f.cFileName), WCHAR(0)) == std::end(f.cFileName) || !safeName(f.cFileName) ||
        (f.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    const auto size = (std::uint64_t(f.nFileSizeHigh) << 32) | f.nFileSizeLow;
    if (size > 8ull * 1024 * 1024 * 1024) return false;
    total += size; if (total > 32ull * 1024 * 1024 * 1024) return false;
    // Never propagate arbitrary attributes from the server to local files.
    f.dwFileAttributes = (f.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    f.dwFlags = FD_ATTRIBUTES | FD_FILESIZE | FD_UNICODE;
  }
  std::lock_guard<std::mutex> lock(impl->mutex); impl->selection = std::move(s);
  return true;
}
}
#else
namespace ofs::rdp {
bool clipboardFileNameSafeUtf8(const char*, std::size_t) { return false; }
std::vector<std::string> localClipboardFiles() { return {}; }
std::string readLocalClipboardText() { return {}; }
std::uint32_t writeLocalClipboardText(const std::string&) { return 0; }
struct LocalClipboardMonitor::Impl {};
LocalClipboardMonitor::LocalClipboardMonitor() : impl(std::make_unique<Impl>()) {}
LocalClipboardMonitor::~LocalClipboardMonitor() {}
void LocalClipboardMonitor::start(Listener) {}
void LocalClipboardMonitor::stop() {}
struct FileClipboard::Impl {};
FileClipboard::FileClipboard() : impl(std::make_unique<Impl>()) {}
FileClipboard::~FileClipboard() = default;
void FileClipboard::clear() {}
bool FileClipboard::publish(std::vector<std::uint8_t>, Reader) { return false; }
}
#endif
