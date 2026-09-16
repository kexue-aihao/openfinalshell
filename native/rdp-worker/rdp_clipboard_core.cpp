#include "rdp_clipboard_core.h"
#include "unicode.h"

#include <algorithm>
#include <fstream>
#include <limits>
#include <set>
#include <string_view>

namespace ofs::rdp {

bool safeRelativePath(std::string_view path) {
  if (path.empty() || !validUtf8(reinterpret_cast<const std::uint8_t*>(path.data()), path.size()) || path.front() == '/' || path.front() == '\\' || path.find(':') != std::string_view::npos) return false;
  std::size_t start = 0;
  while (start <= path.size()) {
    const auto end = path.find_first_of("/\\", start);
    const auto part = path.substr(start, end == std::string_view::npos ? path.size() - start : end - start);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ' ||
        part.find_first_of("<>:\"/\\|?*") != std::string_view::npos) return false;
    for (unsigned char ch : part) if (ch < 32 || ch == 127) return false;
    std::string stem(part.substr(0, part.find('.')));
    std::transform(stem.begin(), stem.end(), stem.begin(), [](unsigned char ch) { return ch >= 'a' && ch <= 'z' ? ch - 'a' + 'A' : ch; });
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
        (stem.size() == 4 && (stem.substr(0, 3) == "COM" || stem.substr(0, 3) == "LPT") && stem[3] >= '1' && stem[3] <= '9')) return false;
    start = end == std::string_view::npos ? path.size() + 1 : end + 1;
  }
  return true;
}

std::filesystem::path relativeFilePath(std::string_view wirePath) {
  std::string path(wirePath);
  std::replace(path.begin(), path.end(), '\\', '/');
  return std::filesystem::u8path(path);
}

bool validateFileEntries(const std::vector<RdpFileEntry>& entries) {
  if (entries.empty() || entries.size() > kMaxClipboardEntries) return false;
  std::uint64_t total = 0;
  std::set<std::string> names, files;
  for (const auto& entry : entries) {
    if (!safeRelativePath(entry.relativePath) || entry.size > kMaxClipboardFileSize ||
        (entry.directory && entry.size != 0) || entry.size > kMaxClipboardTotalSize - total) return false;
    std::vector<std::uint8_t> name;
    if (!utf8ToUtf16Le(entry.relativePath, name, false) || name.size() > 518) return false;
    total += entry.size;
    auto key = relativeFilePath(entry.relativePath).generic_u8string();
    std::transform(key.begin(), key.end(), key.begin(), [](unsigned char ch) { return ch >= 'A' && ch <= 'Z' ? ch + 'a' - 'A' : ch; });
    if (!names.insert(key).second) return false;
    if (!entry.directory) files.insert(key);
  }
  for (const auto& name : names) {
    auto end = name.find('/');
    while (end != std::string::npos) {
      if (files.count(name.substr(0, end))) return false;
      end = name.find('/', end + 1);
    }
  }
  return true;
}

namespace {
std::uint32_t read32(const std::uint8_t* p) {
  return std::uint32_t(p[0]) | (std::uint32_t(p[1]) << 8) | (std::uint32_t(p[2]) << 16) | (std::uint32_t(p[3]) << 24);
}
void write32(std::uint8_t* p, std::uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) p[i] = std::uint8_t(value >> (8 * i));
}
}

bool encodeFileDescriptors(const std::vector<RdpFileEntry>& entries, std::vector<std::uint8_t>& bytes) {
  bytes.clear();
  if (!validateFileEntries(entries)) return false;
  bytes.resize(4 + entries.size() * 592, 0);
  write32(bytes.data(), static_cast<std::uint32_t>(entries.size()));
  for (std::size_t i = 0; i < entries.size(); ++i) {
    auto* p = bytes.data() + 4 + i * 592;
    const auto& entry = entries[i];
    write32(p, 0x80000044u); // FD_UNICODE | FD_FILESIZE | FD_ATTRIBUTES
    write32(p + 36, entry.directory ? 0x10 : 0x80);
    write32(p + 64, static_cast<std::uint32_t>(entry.size >> 32));
    write32(p + 68, static_cast<std::uint32_t>(entry.size));
    auto wireName = entry.relativePath;
    std::replace(wireName.begin(), wireName.end(), '/', '\\');
    std::vector<std::uint8_t> name;
    utf8ToUtf16Le(wireName, name, true);
    std::copy(name.begin(), name.end(), p + 72);
  }
  return true;
}

bool decodeFileDescriptors(const std::uint8_t* bytes, std::size_t length, std::vector<RdpFileEntry>& entries) {
  entries.clear();
  if (!bytes || length < 4) return false;
  const auto count = read32(bytes);
  if (count == 0 || count > kMaxClipboardEntries || length != 4 + count * 592u) return false;
  std::vector<RdpFileEntry> parsed;
  for (std::uint32_t i = 0; i < count; ++i) {
    const auto* p = bytes + 4 + i * 592;
    const auto attributes = read32(p + 36);
    if (attributes & 0x400) return false; // FILE_ATTRIBUTE_REPARSE_POINT
    std::size_t nameLength = 0;
    while (nameLength < 520 && (p[72 + nameLength] || p[73 + nameLength])) nameLength += 2;
    std::string name;
    if (nameLength == 520 || !utf16LeToUtf8(p + 72, nameLength, name, false)) return false;
    parsed.push_back({std::move(name), (std::uint64_t(read32(p + 64)) << 32) | read32(p + 68), (attributes & 0x10) != 0});
  }
  if (!validateFileEntries(parsed)) return false;
  entries = std::move(parsed);
  return true;
}

bool safeLocalFile(const std::filesystem::path& path, std::uint64_t& size, bool& directory) {
  std::error_code ec;
  const auto status = std::filesystem::symlink_status(path, ec);
  if (ec || std::filesystem::is_symlink(status) || (!std::filesystem::is_regular_file(status) && !std::filesystem::is_directory(status))) return false;
  auto parent = path.parent_path();
  while (!parent.empty()) {
    if (std::filesystem::is_symlink(std::filesystem::symlink_status(parent, ec)) || ec) return false;
    const auto next = parent.parent_path();
    if (next == parent) break;
    parent = next;
  }
  directory = std::filesystem::is_directory(status);
  size = directory ? 0 : std::filesystem::file_size(path, ec);
  return !ec && size <= 8ull * 1024 * 1024 * 1024;
}

bool readFileChunk(const std::filesystem::path& path, std::uint64_t offset,
                   std::uint32_t count, std::string& output) {
  output.clear();
  if (count == 0 || count > 4u * 1024u * 1024u) return false;
  std::uint64_t size = 0; bool directory = false;
  if (!safeLocalFile(path, size, directory) || directory || offset > size) return false;
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
