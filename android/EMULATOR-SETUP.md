# API 29 headless emulator acquisition plan

`python3 android/install-test-emulator.py` is a read-only plan. After both final
Android APKs are built and large build caches are removed, install one package
at a time with `--install --package platform-tools`, then `emulator`, then
`api29-image`. The script checks each complete ZIP against the official
repository size and SHA-1 before extraction. It computes SHA-256 for the local
receipt. No signing key is used. It refuses to overwrite any existing SDK
package.

| Official package | URL | ZIP bytes | SHA-1 from Google repository XML | Extracted |
|---|---|---:|---|---:|
| Platform Tools 37.0.3 | `https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip` | 9,571,024 | `e1579b288a7ae4e9bc28dedec6a154d78b3c04ed` | 21.8 MiB |
| Emulator 37.3.9 (Linux x64) | `https://dl.google.com/android/repository/emulator-linux_x64-16863232.zip` | 350,070,672 | `5c3eeebb678f7f94a45a0b963409d8e875d1962d` | 851.6 MiB |
| Android 29 default x86_64 image r08 | `https://dl.google.com/android/repository/sys-img/android/x86_64-29_r08-linux.zip` | 689,676,765 | `e4b798d6fcddff90d528d74ef22ce3dd4a2ca798` | 3,217.5 MiB logical; sparse disk allocation must be measured |

The default image is the smallest official API 29 x86_64 choice in the current
metadata. The Google APIs alternative is 1,314,706,136 bytes compressed and
is unnecessary for the native/WebView/installer checks. The default image has
`system.img` (3,232,759,808 logical bytes), `vendor.img`, `userdata.img`,
kernel and ramdisk. Extraction skips zero-filled 4 KiB blocks in `.img` files,
but its actual disk use is unknown until performed. Preserve the image's
`NOTICE.txt` and the NDK's `NOTICE`/`NOTICE.toolchain` for source notices.

Plan for roughly 22 MiB Platform Tools, 852 MiB emulator, the measured sparse
image allocation, and up to 1,536 MiB mutable emulator data. Install the
packages sequentially; each verified ZIP is deleted before the next download.
The image step checks for at least 2,350 MiB free, but runtime data requires
additional space. With an 8 GiB overlay, first remove expendable Rust/Docker
build caches after the final APKs and source notices have been preserved.

Create `build/android-avd/spektralab29.ini` with an absolute `path` to
`build/android-avd/spektralab29.avd`, and put this `config.ini` inside the AVD:

```ini
AvdId=spektralab29
abi.type=x86_64
avd.ini.displayname=SpektraLab API 29
disk.dataPartition.size=1536M
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.lcd.density=320
hw.lcd.height=1280
hw.lcd.width=800
hw.ramSize=1536
image.sysdir.1=/absolute/path/to/build/android-sdk/system-images/android-29/default/x86_64/
tag.display=Default
tag.id=default
```

Set `ANDROID_HOME` to `build/android-sdk` and `ANDROID_AVD_HOME` to
`build/android-avd`. The headless software command is:

```sh
build/android-sdk/emulator/emulator -avd spektralab29 -data build/emulator-data.img \
  -no-window -no-audio -no-boot-anim -accel off -gpu swiftshader_indirect \
  -memory 1536 -cores 2 -partition-size 1536 -no-snapshot
```

No KVM acceleration is assumed. This is an API 29 emulator test, not physical
Xiaomi verification. Before accepting Android results, compare installed base
APK SHA-256 against each final artifact and run the native Checks plus the
cancel/confirm OS upgrade rehearsal in `UPGRADE-REHEARSAL.md`.
