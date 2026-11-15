# Windows build 13304 packaging

`package-windows133.py` stages a previously compiled and validated runtime. It does not rebuild binaries or certify GUI behavior. Its input is `artifacts/Compiled-Windows-13304/`, including `COMPILE-CHECKPOINT.json`. The checkpoint must be refreshed with the final GUI, CLI, host, resource and licence hashes after the final frontend rebuild and validation; a `COMPILED ONLY` checkpoint cannot be packaged.

The source companions come from the current checkout and the verified archived dependency sources at `/workspace/recovery/installer/source`. The script requires the archived Cargo and npm locks to match the current locks exactly, verifies the archived dependency source and licence hashes against the archived installer manifest, and rejects secret-key filenames or PEM private-key contents from the current source snapshot. It checks that SHA-256 of the exact bytes of `distribution/updater/public-key.json` is `bc81a5943f53c7dec4dcce81f9c3ab6ee281a961df2193fc6cb789e60a850e9c`.

First run the read-only check:

```sh
python3 distribution/windows/package-windows133.py --check
```

After final tests and an updated checkpoint, stage the release:

```sh
python3 distribution/windows/package-windows133.py
```

This produces a **runtime-only** directory, `artifacts/SpektraLab-Windows-1.3.3-LightTable-x64/`, and separate source companions in `artifacts/SpektraLab-Windows-13304-Source/`. The source directory contains the current project source ZIP, the archived Rust/npm/LibRaw dependency source ZIPs, notices ZIP, index and SHA-256 receipt. These source companions belong beside the installer in the final release; they are not installed into the user's application folder. No additional full portable ZIP is generated.

The installer requires an external Unicode NSIS 3 `makensis`. It is not bundled or downloaded by these scripts. When supplied, verify the staged files, then build the stable updater asset name:

```sh
python3 distribution/windows/build-installer-windows133.py --check
python3 distribution/windows/build-installer-windows133.py --makensis /path/to/makensis
```

The output is `artifacts/SpektraLab-Windows-x64-Setup.exe`. It defaults to `E:\SpektraLab`, offers a desktop shortcut, and checks for WebView2 before replacing application files. Interactive setup warns before closing the old SpektraLab GUI; silent setup is used only after the app's updater has flushed edits. The copied updater helper is named `SpektraLab-UpdateHelper.exe` and is not targeted by the installer close step.

The generated uninstaller removes exactly the runtime stage's manifest-listed files, its own uninstaller, shortcuts and registration. It then attempts to remove empty owned directories. Unrelated files, photographs and app data remain. WebView2 is a shared Microsoft runtime and is not uninstalled.

A layout check under Wine and a real Windows GUI/update check remain separate validation steps. `--check` verifies hashes and source identity only. Once the final installer exists and the `spektralab-wine10` container is ready, `python3 distribution/windows/check-installer-windows133.py` maps an isolated Wine E: drive, invokes the installer with `/S /NO_WEBVIEW=1` and no `/D` override, verifies all installed payload hashes and the desktop shortcut, then verifies exact uninstall removal while preserving an unrelated file and AppData marker. Its receipt records that WebView2 prerequisite installation and a real Windows GUI were not tested. `python3 distribution/windows/check-installer-windows133.py --check` is a read-only script/path check available before packaging. Do not present the archived build's validation reports as results for build 13304.
