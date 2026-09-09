// Exercise the OLE data object without taking ownership of the user's clipboard.
#include "../file_clipboard.cpp"
#include <cassert>
int main() {
#if defined(_WIN32)
  using namespace ofs::rdp;
  assert(safeName(L"folder\\file.txt"));
  assert(!safeName(L"..\\escape.txt"));
  assert(!safeName(L"C:\\escape.txt"));
  assert(!safeName(L"folder\\..\\escape.txt"));
  assert(!safeName(L"folder\\NUL.txt"));
  assert(!safeName(L"folder\\com1"));
  assert(safeName(L"folder\\computer.txt"));
  auto selection = std::make_shared<Selection>();
  FILEDESCRIPTORW descriptor{};
  descriptor.nFileSizeLow = 5;
  wcscpy_s(descriptor.cFileName, L"hello.txt");
  selection->files.push_back(descriptor);
  unsigned reads = 0;
  selection->read = [&](std::uint32_t index, std::uint64_t offset, std::uint32_t count, std::vector<std::uint8_t>& bytes) {
    assert(index == 0); ++reads;
    const std::string text = "hello";
    bytes.assign(text.begin() + offset, text.begin() + offset + count); return true;
  };
  auto* object = new FileObject(selection);
  FORMATETC format{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"FileGroupDescriptorW")), nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  STGMEDIUM medium{};
  assert(object->GetData(&format, &medium) == S_OK);
  assert(reads == 0); // Copy and file enumeration must not download content.
  auto* group = static_cast<FILEGROUPDESCRIPTORW*>(GlobalLock(medium.hGlobal));
  assert(group->cItems == 1 && group->fgd[0].nFileSizeLow == 5);
  GlobalUnlock(medium.hGlobal); ReleaseStgMedium(&medium);
  format.cfFormat = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"FileContents"));
  format.tymed = TYMED_ISTREAM; format.lindex = 0;
  assert(object->GetData(&format, &medium) == S_OK && reads == 0);
  char data[8]{}; ULONG count = 0;
  assert(medium.pstm->Read(data, 2, &count) == S_OK && count == 2 && std::string(data, 2) == "he");
  IStream* clone = nullptr; assert(medium.pstm->Clone(&clone) == S_OK);
  assert(clone->Read(data, 8, &count) == S_FALSE && count == 3 && std::string(data, 3) == "llo");
  LARGE_INTEGER zero{};
  assert(medium.pstm->Seek(zero, STREAM_SEEK_SET, nullptr) == S_OK);
  assert(medium.pstm->Read(data, 5, &count) == S_OK && std::string(data, 5) == "hello");
  selection->valid = false;
  assert(clone->Read(data, 1, &count) == STG_E_REVERTED);
  assert(object->QueryGetData(&format) == DV_E_FORMATETC);
  clone->Release(); ReleaseStgMedium(&medium); object->Release();

  // Exercise COM marshalling across apartments, as an Explorer consumer does,
  // without replacing the user's system clipboard.
  assert(SUCCEEDED(OleInitialize(nullptr)));
  selection->valid = true;
  object = new FileObject(selection);
  IStream* marshaled = nullptr;
  assert(SUCCEEDED(CoMarshalInterThreadInterfaceInStream(IID_IDataObject, object, &marshaled)));
  std::atomic_bool finished{false};
  std::thread consumer([&] {
    assert(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)));
    IDataObject* proxy = nullptr;
    assert(SUCCEEDED(CoGetInterfaceAndReleaseStream(marshaled, IID_IDataObject, reinterpret_cast<void**>(&proxy))));
    FORMATETC request{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"FileContents")), nullptr, DVASPECT_CONTENT, 0, TYMED_ISTREAM};
    STGMEDIUM result{};
    assert(SUCCEEDED(proxy->GetData(&request, &result)));
    char content[5]{};
    ULONG actual = 0;
    assert(result.pstm->Read(content, 5, &actual) == S_OK);
    assert(actual == 5 && std::string(content, actual) == "hello");
    ReleaseStgMedium(&result);
    proxy->Release();
    CoUninitialize();
    finished = true;
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!finished) {
    assert(std::chrono::steady_clock::now() < deadline);
    MSG msg{};
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  consumer.join();
  object->Release();
  OleUninitialize();
#endif
}
