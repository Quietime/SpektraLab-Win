#include "disk_cache.hpp"
#include "platform.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sstream>
#include <iomanip>

namespace spkhost {namespace {
namespace fs=std::filesystem;
std::mutex mutex;fs::path directory;uint64_t limit=uint64_t(8)<<30,hits=0,misses=0,evictions=0;
constexpr std::array<char,8> magic={'S','P','K','D','C','0','0','1'};
// This hash locates/checks cache entries; the complete source/options key is
// also verified on every read, so a hash collision never reuses other pixels.
uint64_t hash(const void* bytes,size_t size,uint64_t value=14695981039346656037ull){
 const auto* p=static_cast<const uint8_t*>(bytes);for(size_t i=0;i<size;i++){value^=p[i];value*=1099511628211ull;}return value;
}
fs::path location(const std::string& key){std::ostringstream name;name<<std::hex<<std::setfill('0')<<std::setw(16)<<hash(key.data(),key.size())<<".spkc";return directory/name.str();}
struct Entry {fs::path path;uint64_t bytes;fs::file_time_type touched;};
std::vector<Entry> entries(){std::vector<Entry> result;std::error_code ec;
 for(fs::directory_iterator it(directory,ec),end;!ec&&it!=end;it.increment(ec)){
  if(it->path().extension()!=".spkc"||!it->is_regular_file(ec))continue;
  const auto bytes=it->file_size(ec);if(ec){ec.clear();continue;}
  const auto touched=it->last_write_time(ec);if(ec){ec.clear();continue;}
  result.push_back({it->path(),bytes,touched});
 }return result;
}
void evict(){auto files=entries();uint64_t total=0;for(const auto& f:files)total+=f.bytes;
 std::sort(files.begin(),files.end(),[](const auto& a,const auto& b){return a.touched<b.touched;});
 for(const auto& f:files){if(total<=limit)break;std::error_code ec;if(fs::remove(f.path,ec)){total-=f.bytes;evictions++;}}
}
spk::Json info(){auto out=spk::Json::object();uint64_t bytes=0;const auto files=entries();for(const auto& f:files)bytes+=f.bytes;
 out.set("available",spk::Json(!directory.empty()));out.set("path",spk::Json(path_utf8(directory)));
 out.set("bytes",spk::Json(double(bytes)));out.set("limit_bytes",spk::Json(double(limit)));out.set("entries",spk::Json(double(files.size())));
 out.set("hits",spk::Json(double(hits)));out.set("misses",spk::Json(double(misses)));out.set("evictions",spk::Json(double(evictions)));return out;
}
}
void configure_disk_cache(const fs::path& path){std::lock_guard guard(mutex);directory=path;
 if(!directory.empty()){std::error_code ec;fs::create_directories(directory,ec);if(ec)directory.clear();else evict();}}
spk::Json disk_cache_info(){std::lock_guard guard(mutex);return info();}
spk::Json set_disk_cache_limit(uint64_t bytes){std::lock_guard guard(mutex);limit=std::min(bytes,uint64_t(256)<<30);evict();return info();}
spk::Json clear_disk_cache(){std::lock_guard guard(mutex);for(const auto& file:entries()){std::error_code ec;fs::remove(file.path,ec);}return info();}
std::string decode_cache_key(const fs::path& path,const DecodeOptions& options){
 std::error_code ec;const auto size=fs::file_size(path,ec);if(ec)return {};
 const auto modified=fs::last_write_time(path,ec);if(ec)return {};
 auto canonical=fs::weakly_canonical(path,ec);if(ec)return {};
 auto key=spk::Json::object();
 key.set("version",spk::Json(std::string("libraw-0.22.2/prophoto-1/lensfun-0.3.4/3")));
 key.set("path",spk::Json(path_utf8(canonical)));key.set("size",spk::Json(std::to_string(size)));
 key.set("modified",spk::Json(file_timestamp_key(modified)));
 key.set("mode",spk::Json(options.raw_mode));key.set("lens",spk::Json(options.lens_correction));
 if(options.temperature_k)key.set("temperature",spk::Json(*options.temperature_k));
 if(options.tint)key.set("tint",spk::Json(*options.tint));return key.dump();
}
bool read_decode_cache(const std::string& key,FloatImage& image){std::lock_guard guard(mutex);
 if(directory.empty()||key.empty()||!limit)return false;
 auto fail=[&](){misses++;return false;};const auto file=location(key);
 std::FILE* input=open_file(file,"rb");if(!input)return fail();
 struct Close {std::FILE* p;~Close(){std::fclose(p);}} close{input};
 std::array<char,8> signature{};uint32_t size=0;
 if(std::fread(signature.data(),1,8,input)!=8||signature!=magic||std::fread(&size,4,1,input)!=1||size>16384)return fail();
 std::string text(size,'\0');if(std::fread(text.data(),1,size,input)!=size)return fail();
 spk::Json header;std::string error;if(!spk::Json::parse(text,header,error)||header.at("key").as_string()!=key)return fail();
 const int w=header.at("width").as_int(),h=header.at("height").as_int();
 if(w<1||h<1||uint64_t(w)*h>uint64_t(1)<<28)return fail();
 const uint64_t length=uint64_t(w)*h*3*sizeof(float);std::error_code ec;
 if(fs::file_size(file,ec)!=12+size+length||ec||length>limit)return fail();
 std::vector<float> rgb(size_t(w)*h*3);if(std::fread(rgb.data(),1,size_t(length),input)!=length)return fail();
 if(std::to_string(hash(rgb.data(),size_t(length)))!=header.at("checksum").as_string())return fail();
 image={uint32_t(w),uint32_t(h),std::move(rgb)};hits++;fs::last_write_time(file,fs::file_time_type::clock::now(),ec);return true;
}
void write_decode_cache(const std::string& key,const FloatImage& image){std::lock_guard guard(mutex);
 const uint64_t bytes=image.rgb.size()*sizeof(float);if(directory.empty()||key.empty()||bytes+16384>limit||!image.width||!image.height)return;
 auto header=spk::Json::object();header.set("key",spk::Json(key));header.set("width",spk::Json(double(image.width)));header.set("height",spk::Json(double(image.height)));
 header.set("checksum",spk::Json(std::to_string(hash(image.rgb.data(),size_t(bytes)))));const auto text=header.dump();
 const auto file=location(key);fs::path partial=file;partial+=".partial";
 std::FILE* output=open_file(partial,"wb");if(!output)return;
 const uint32_t length=uint32_t(text.size());bool ok=std::fwrite(magic.data(),1,8,output)==8&&std::fwrite(&length,4,1,output)==1&&
  std::fwrite(text.data(),1,text.size(),output)==text.size()&&std::fwrite(image.rgb.data(),1,size_t(bytes),output)==bytes;
 if(std::fclose(output)!=0)ok=false;std::error_code ec;
 if(ok){fs::remove(file,ec);ec.clear();fs::rename(partial,file,ec);}
 if(!ok||ec)fs::remove(partial,ec);evict();
}
}
