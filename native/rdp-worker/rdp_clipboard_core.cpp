#include "rdp_clipboard_core.h"

#include <fstream>
#include <limits>
#include <string_view>

namespace ofs::rdp {

bool safeRelativePath(std::string_view path) {
  if (path.empty() || path.front() == '/' || path.front() == '\\' || path.find(':') != std::string_view::npos) return false;
  std::size_t start = 0;
  while (start <= path.size()) {
    const auto end = path.find_first_of("/\\", start);
    const auto part = path.substr(start, end == std::string_view::npos ? path.size() - start : end - start);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ' ||
        part.find_first_of("<>:\"/\\|?*") != std::string_view::npos) return false;
    start = end == std::string_view::npos ? path.size() + 1 : end + 1;
  }
  return true;
}

bool safeLocalFile(const std::filesystem::path& path, std::uint64_t& size, bool& directory) {
  std::error_code ec;
  const auto status = std::filesystem::symlink_status(path, ec);
  if (ec || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status) && !std::filesystem::is_directory(status)) return false;
  directory = std::filesystem::is_directory(status);
  size = directory ? 0 : std::filesystem::file_size(path, ec);
  return !ec && size <= 8ull * 1024 * 1024 * 1024;
}

bool readFileChunk(const std::filesystem::path& path, std::uint64_t offset,
                   std::uint32_t count, std::string& output) {
  output.clear();
  if (count == 0 || count > 4u * 1024u * 1024u) return false;
  std::ifstream input(path, std::ios::binary);
  if (!input) return false;
  input.seekg(0, std::ios::end);
  const auto length = input.tellg();
  if (length < 0 || offset > static_cast<std::uint64_t>(length)) return false;
  input.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  output.resize(count);
  input.read(output.data(), static_cast<std::streamsize>(count));
  output.resize(static_cast<std::size_t>(input.gcount()));
  return input.good() || input.eof();
}

} // namespace ofs::rdp
