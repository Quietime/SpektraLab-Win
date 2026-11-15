# Android managed update rehearsal

The rebuilt release installs as `app.spektralab.lighttable` at build 13304. The older `app.spektralab.android` application is a separate package and must remain installed with its data intact. All fixture feeds and predecessor APKs in this procedure are local test inputs; they are never published or bundled into the product.

After both final phone/tablet APKs and their exact-byte signed test feed exist, derive a full build 13303 predecessor for each flavor:

```bash
python3 android/build-upgrade-previous.py --final artifacts/SpektraLab-Android-Phone-1.3.3-LightTable.apk --flavor phone
python3 android/build-upgrade-previous.py --final artifacts/SpektraLab-Android-Tablet-1.3.3-LightTable.apk --flavor tablet
```

For one flavor at a time, build the separate checks APK with the exact final APK bytes and test feed. The checks APK will include local fixtures; the product APK includes only the update public key.

```bash
SPEKTRALAB_ANDROID_UPGRADE_APK=artifacts/SpektraLab-Android-Phone-1.3.3-LightTable.apk \
SPEKTRALAB_ANDROID_UPGRADE_MANIFEST=build/android-upgrade-feed/updates.json \
SPEKTRALAB_ANDROID_UPGRADE_SIGNATURE=build/android-upgrade-feed/updates.json.sig \
SPEKTRALAB_ANDROID_UPGRADE_FLAVOR=phone python3 android/build-checks.py
```

Use a disposable API 29 emulator. Install final build 13304 plus the checks APK and run full `app.spektralab.checks/.Checks` first. Compare the installed `pm path app.spektralab.lighttable` base APK SHA-256 with the final artifact. Then uninstall only `app.spektralab.lighttable` on that test emulator, install `build/android-upgrade/phone/previous-13303.apk` and the checks APK, allow install from this source, and run:

```bash
adb shell am instrument -w -r -e mode stageUpgrade app.spektralab.checks/.Checks
adb shell input keyevent BACK
adb shell am instrument -w -r -e mode afterCancel app.spektralab.checks/.Checks
adb shell am instrument -w -r -e mode stageUpgrade app.spektralab.checks/.Checks
```

Approve the second Android OS installer prompt on screen. Once Android installs and the application relaunches, run `-e mode afterUpgrade`. It verifies actual installed build 13304, removal of only five fixed managed update files, and retention of `unrelated.keep`. `stageUpgrade` alone proves only installer handoff. Also verify the archive signer query on API 29 using both the test APK and an actual full APK; the lost environment returned `signingInfo=null` for a tiny v3-signed fixture, and no full-APK fallback result survived recovery. Do not claim physical Xiaomi testing from emulator results.
