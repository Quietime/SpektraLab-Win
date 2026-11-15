// Portable correction using the Lensfun 0.3.4 measured calibration database.
// Database: CC BY-SA 3.0; interpolation/coordinate equations adapted from
// Lensfun (LGPL-3.0, combined here under GPL-3.0 per LGPL section 2b).
#pragma once
#include <filesystem>
#include <string>
#include "image_io.hpp"
namespace spkhost {
struct LensCorrectionReport {std::string profile;double zoom=1;bool distortion=false,tca=false,vignetting=false;};
void configure_lens_database(const std::filesystem::path& file);
std::string matched_lens_profile(const Metadata& metadata);
bool correct_lens(FloatImage& image,const Metadata& metadata,LensCorrectionReport& report,std::string& error);
}
