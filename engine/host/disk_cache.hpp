// Rebuildable linear decode cache. No original or sidecar is stored here.
#pragma once
#include "image_io.hpp"
#include "core/json.hpp"
namespace spkhost {
void configure_disk_cache(const std::filesystem::path& directory);
spk::Json disk_cache_info();
spk::Json set_disk_cache_limit(uint64_t bytes);
spk::Json clear_disk_cache();
std::string decode_cache_key(const std::filesystem::path&,const DecodeOptions&);
bool read_decode_cache(const std::string& key,FloatImage& image);
void write_decode_cache(const std::string& key,const FloatImage& image);
}
