#!/usr/bin/env bash
# Run from the corresponding source checkout on Linux, with Rust 1.90,
# Node 24, CMake, Ninja, glslangValidator and MinGW-w64 installed.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
engine/build-windows-cross.sh
cd desktop
npm ci --no-audit --no-fund
npm run check
npm run build:web
cd src-tauri
rustup target add x86_64-pc-windows-gnu
TAURI_CONFIG="$(cat tauri.windows133.json)" \
  cargo build --target x86_64-pc-windows-gnu --release --features custom-protocol --locked --bins -j3
echo 'Main program: desktop/src-tauri/target/x86_64-pc-windows-gnu/release/spektralab.exe'
echo 'Put it beside spektralab-host.exe; resources go in host/engine, licences in host/licenses.'
echo 'Also put the x64 WebView2Loader.dll from locked webview2-com-sys 0.39.1 beside it.'
echo 'The corresponding Microsoft SDK licence and notice must accompany the DLL.'
