#include "../rdp_clipboard_core.h"
#include <cassert>
#include <fstream>

int main() {
  using namespace ofs::rdp;
  assert(safeRelativePath("folder/file.txt"));
  assert(!safeRelativePath("../file.txt"));
  assert(!safeRelativePath("C:/file.txt"));
  assert(!safeRelativePath("folder/"));
  const auto path = std::filesystem::temp_directory_path() / "ofs-rdp-clipboard-core-test.bin";
  { std::ofstream out(path, std::ios::binary); out << "abcdef"; }
  std::uint64_t size = 0; bool directory = true;
  assert(safeLocalFile(path, size, directory) && size == 6 && !directory);
  std::string chunk;
  assert(readFileChunk(path, 2, 3, chunk) && chunk == "cde");
  std::error_code ec; std::filesystem::remove(path, ec);
}
