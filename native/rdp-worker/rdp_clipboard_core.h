#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace ofs::rdp {

struct RdpFileEntry {
  std::string relativePath;
  std::uint64_t size = 0;
  bool directory = false;
};

constexpr std::size_t kMaxClipboardEntries = 64;
constexpr std::uint64_t kMaxClipboardFileSize = 8ull * 1024 * 1024 * 1024;
constexpr std::uint64_t kMaxClipboardTotalSize = 32ull * 1024 * 1024 * 1024;
// MS-RDPECLIP FILEDESCRIPTORW is a fixed 592-byte little-endian wire
// structure. Never use the host's wchar_t, alignment, or Win32 SDK to decode it.
bool encodeFileDescriptors(const std::vector<RdpFileEntry>& entries, std::vector<std::uint8_t>& bytes);
bool decodeFileDescriptors(const std::uint8_t* bytes, std::size_t length, std::vector<RdpFileEntry>& entries);
bool validateFileEntries(const std::vector<RdpFileEntry>& entries);
std::filesystem::path relativeFilePath(std::string_view wirePath);

bool safeRelativePath(std::string_view path);
bool safeLocalFile(const std::filesystem::path& path, std::uint64_t& size, bool& directory);
bool readFileChunk(const std::filesystem::path& path, std::uint64_t offset,
                   std::uint32_t count, std::string& output);

} // namespace ofs::rdp
