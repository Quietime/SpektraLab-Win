#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
abi="${1:-arm64-v8a}"
sdk="${ANDROID_HOME:-$repo/build/android-sdk}"
flexible=OFF
if [[ "$abi" == arm64-v8a ]]; then flexible=ON; fi
cmake -S "$repo" -B "$repo/build/android-$abi" -G Ninja \
 -DCMAKE_TOOLCHAIN_FILE="$sdk/ndk/27.2.12479018/build/cmake/android.toolchain.cmake" \
 -DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES="$flexible" -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-29 -DANDROID_STL=c++_static \
 -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DSPEKTRALAB_BUILD_HOST=ON \
 -DSPEKTRALAB_BUILD_NATIVE_RAW=ON -DSPEKTRALAB_BUILD_DESKTOP=OFF \
 -DSPEKTRALAB_REQUIRE_VULKAN=ON -DSPEKTRALAB_HOST_VERSION=1.3.3-lighttable.5 \
 -DSPEKTRALAB_VULKAN_HEADERS="$repo/build/deps/Vulkan-Headers/include" \
 -DSPEKTRALAB_GLSLANG="$(command -v glslangValidator)"
cmake --build "$repo/build/android-$abi" --target spektralab-host spektralab_vulkan_resources --parallel 3
