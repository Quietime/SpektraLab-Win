Offline signed updater validation fixtures for build 13305. All three channels are present. The URL tag is deliberately nonexistent; no installer or APK payload is present. Never execute or fetch these fixture URLs. `missing-installed-hash` is Windows-specific.

The signatures cover each JSON file's exact UTF-8 bytes. Git must check out the JSON and `.sig` text with LF line endings on Windows too; do not rewrite or normalize bytes in the production verifier.
