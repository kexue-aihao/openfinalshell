#include "../rdp_clipboard_core.h"
#include <cassert>
#include <fstream>

int main() {
  using namespace ofs::rdp;
  assert(safeRelativePath("folder/file.txt"));
  assert(!safeRelativePath("../file.txt"));
  assert(!safeRelativePath("C:/file.txt"));
  assert(!safeRelativePath("folder/"));
  assert(!safeRelativePath("folder\\CON.txt"));
  assert(!safeRelativePath(std::string("a\0b", 3)));
  assert(!safeRelativePath("folder\\LPT1"));
  assert(!safeRelativePath("folder\\trailing. "));
  assert(!safeRelativePath("\\\\server\\file"));
  assert(relativeFilePath("folder\\file.txt").generic_u8string() == "folder/file.txt");
  std::vector<RdpFileEntry> entries{{"folder", 0, true}, {"folder\\中文 📝.txt", (1ull << 32) + 3, false}};
  std::vector<std::uint8_t> descriptors;
  assert(encodeFileDescriptors(entries, descriptors));
  assert(descriptors.size() == 4 + 2 * 592);
  std::vector<RdpFileEntry> parsed;
  assert(decodeFileDescriptors(descriptors.data(), descriptors.size(), parsed));
  assert(parsed.size() == 2 && parsed[0].directory && parsed[1].relativePath == entries[1].relativePath && parsed[1].size == entries[1].size);
  auto invalid = descriptors;
  invalid[4 + 36 + 1] = 4; // reparse point
  assert(!decodeFileDescriptors(invalid.data(), invalid.size(), parsed));
  assert(!decodeFileDescriptors(descriptors.data(), descriptors.size() - 1, parsed));
  invalid = descriptors;
  for (unsigned i = 0; i < 520; i += 2) { invalid[4 + 72 + i] = 'a'; invalid[4 + 72 + i + 1] = 0; }
  assert(!decodeFileDescriptors(invalid.data(), invalid.size(), parsed));
  assert(!encodeFileDescriptors({{"../file", 1, false}}, invalid));
  assert(!encodeFileDescriptors({{"dir", 1, false}, {"dir/file", 1, false}}, invalid));
  assert(!encodeFileDescriptors({{"name.txt", 1, false}, {"NAME.txt", 1, false}}, invalid));
  assert(!encodeFileDescriptors({{"huge", kMaxClipboardFileSize + 1, false}}, invalid));
  auto tooMany = std::vector<RdpFileEntry>(65, {"file", 0, false});
  assert(!encodeFileDescriptors(tooMany, invalid));
  const auto path = std::filesystem::temp_directory_path() / "ofs-rdp-clipboard-core-test.bin";
  { std::ofstream out(path, std::ios::binary); out << "abcdef"; }
  std::uint64_t size = 0; bool directory = true;
  assert(safeLocalFile(path, size, directory) && size == 6 && !directory);
  std::string chunk;
  assert(readFileChunk(path, 2, 3, chunk) && chunk == "cde");
  assert(readFileChunk(path, 4, 5, chunk) && chunk == "ef");
  assert(!readFileChunk(path, 7, 1, chunk));
  assert(!readFileChunk(path, 0, 5 * 1024 * 1024, chunk));
  std::error_code ec; std::filesystem::remove(path, ec);
}
