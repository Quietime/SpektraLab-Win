# SpektraLab managed update contract v1

This is the shared Windows, Android and frontend contract for the rebuilt release `1.3.3-lighttable.3`, build **13304**. It replaces the lost build's signing identity. On 2026-11-15 the owner authorized publishing the current source to `Quietime/SpektraLab-Win` before continuing verification. Source publication does not signify release acceptance: unverified installers remain unpublished drafts, and signing secrets stay private.

## Installed identity and channels

| Channel | Stable release asset name | Installed identity |
|---|---|---|
| `windows-x64` | `SpektraLab-Windows-x64-Setup.exe` | Tauri `app.spektralab.windows133`; `SpektraLab-Windows.exe` |
| `android-phone-arm64` | `SpektraLab-Android-Phone.apk` | Android `app.spektralab.lighttable` |
| `android-tablet-arm64` | `SpektraLab-Android-Tablet.apk` | Android `app.spektralab.lighttable` |

Android phone/tablet variants use the same new signing certificate and package ID, with immutable Manifest metadata `app.spektralab.update_channel` selecting the channel. Validate the downloaded APK's embedded channel; never infer it from the filename or choose a different channel as fallback. Java classes may remain under `app.spektralab.android`, but the Manifest uses absolute class names and an authority unique to the new application, `app.spektralab.lighttable.updates`.

The new Android application is a parallel installation to the old `app.spektralab.android` package. It must not uninstall the old package or clear its data. Its lost signing key cannot be reconstructed or replaced by the new key for an in-place update.

## Feed and transport

The only feed is:

`GET https://api.github.com/repos/Quietime/SpektraLab-Win/releases/latest`

Accept a published stable release only: `draft` and `prerelease` must both be false. Find exactly one asset named `updates.json` and exactly one named `updates.json.sig` in its asset list. A GitHub 404 means no published update, not a fatal app or editor startup error. Do not query upstream Mac/community repositories for executable updates.

Every initial manifest, signature or package asset URL must have exactly this form:

`https://github.com/Quietime/SpektraLab-Win/releases/download/<tag>/<expected-name>`

Use structural URL validation: exact HTTPS scheme/host/repository path and expected asset name, exactly one nonempty tag segment, no credentials, custom port, query, fragment, backslash, encoded path separators or dot traversal. A substring/prefix match alone is insufficient. The coordinator's release tag uses plain safe characters, for example `v1.3.3-lighttable.3`.

Follow at most five HTTPS redirects to support GitHub asset delivery. Preserve certificate validation; never downgrade to HTTP or relax TLS checks. Bound connection/read timeouts and streamed response sizes. No remote webpage may load into the bridge-enabled WebView.

| Response | Maximum size |
|---|---|
| GitHub release JSON | 1 MiB |
| Raw manifest | 64 KiB |
| Signature text file, including optional surrounding whitespace | 4 KiB |
| Installer/APK | 512 MiB |

## Signature and public key format

Verify the detached signature **before interpreting any manifest field**. The signature is RSA-3072, PKCS#1 v1.5, SHA-256 over the **exact raw bytes** of `updates.json`, including any final newline. Do not parse and serialize JSON before verification.

After trimming surrounding ASCII whitespace, `updates.json.sig` contains exactly **768 hexadecimal characters**, encoding the 384-byte signature. Uppercase and lowercase hex are accepted. It is not Base64, PEM or a JSON wrapper.

The compiled/packaged public key is `distribution/updater/public-key.json`:

```json
{"algorithm":"RSA-PKCS1-SHA256","modulus":"<768 hex characters>","exponent":"010001"}
```

`modulus` is the unsigned, big-endian 3072-bit RSA modulus. `exponent` is big-endian hex for 65537. The field names are **`modulus` and `exponent`**, not the previous implementation's `modulus_hex` / `exponent_hex`. Both native clients consume the same file and algorithm. Android packages it as `assets/update-public-key.json`; tests compare those bytes against the intended public key.

The coordinator's replacement key fingerprint is recorded in `RECOVERY-PLAN.md`; packaging must reproduce and describe its fingerprint calculation. Private keys/passwords stay outside Git, product packages, corresponding source and public Release assets. Root owns signing and the separately protected maintenance backup.

## Signed manifest schema

This example describes the current release; native clients must report build 13304 as current rather than offer to install it over itself. Future update fixtures and releases use a larger integer build.

```json
{
  "schema":1,
  "build":13304,
  "version":"1.3.3-lighttable.3",
  "notes":"Release notes",
  "channels":{
    "windows-x64":{
      "name":"SpektraLab-Windows-x64-Setup.exe",
      "url":"https://github.com/Quietime/SpektraLab-Win/releases/download/v1.3.3-lighttable.3/SpektraLab-Windows-x64-Setup.exe",
      "sha256":"<64 hex characters>",
      "bytes":123,
      "installed_sha256":"<64 hex characters>"
    },
    "android-phone-arm64":{
      "name":"SpektraLab-Android-Phone.apk",
      "url":"https://github.com/Quietime/SpektraLab-Win/releases/download/v1.3.3-lighttable.3/SpektraLab-Android-Phone.apk",
      "sha256":"<64 hex characters>",
      "bytes":123
    },
    "android-tablet-arm64":{
      "name":"SpektraLab-Android-Tablet.apk",
      "url":"https://github.com/Quietime/SpektraLab-Win/releases/download/v1.3.3-lighttable.3/SpektraLab-Android-Tablet.apk",
      "sha256":"<64 hex characters>",
      "bytes":123
    }
  }
}
```

- `schema` is the JSON integer 1. `build` is a positive JSON integer no greater than 2147483647, shared by Windows's embedded build and Android's versionCode. Reject strings, booleans, fractional values, zero, negatives and overflow. `version` is a nonempty human-readable string; update ordering uses `build`.
- Each release contains all three channels. A client validates/selects its exact channel and never substitutes another platform/flavor. `name` must equal that channel's stable asset name, and `url` must end in that exact name under the allowed release location.
- `bytes` is a positive JSON integer no greater than 536870912. `sha256` is exactly 64 hex characters for the downloaded package bytes. Compare decoded digest values rather than relying on letter case.
- Windows **requires** `installed_sha256`, exactly 64 hex characters for the final installed `SpektraLab-Windows.exe`, distinct from the installer digest. It authorizes the installed executable success check. Android does not require a Windows-only installed-executable hash.
- A valid signed current/older build is a normal up-to-date result: `available:false`, with **no error**. Prepare/install refuse it without launching an installer. Invalid metadata or failed verification remains an error.

## Shared native commands and frontend behavior

The bridge/Tauri commands accept **no update URL, filesystem path, executable, channel or build arguments** from the frontend:

- `check_updates`: discover/verify a release and reconcile an already prepared package.
- `update_prepare`: obtain a newer, verified package for the installed channel.
- `update_install`: revalidate the prepared package and initiate native installation.

Return a status object with:

```ts
{
  channel:string,
  current_build:number,
  available:boolean,
  ready:boolean,
  version?:string,
  build?:number,
  bytes?:number,
  notes?:string,
  url?:string,
  error?:string,
  installation_pending?:boolean
}
```

`ready:true` means a complete package was verified, not that installation succeeded. `installation_pending:true` means the OS/installer handoff is pending, not that the app was updated. Native resolved error statuses and rejected commands both become visible frontend errors; never discard a resolved `error` field. Offline/network failure does not block app startup. A previously verified staged package may remain installable offline after native revalidation.

Automatic checks run non-blockingly after startup and approximately every 24 hours while foregrounded, with foreground reconciliation after an Android install handoff. Settings provides manual check/download/install actions. Cancellation must leave retry accessible. No automatic installation or interruption of active edits/export.

Before requesting installation, refuse while `batchExporting`, then await in order `flushPairChanges(false)`, `flushSave(true)`, `flushFrameOrder()`, `saveTable()`. A save failure blocks installation; recheck export state before native handoff.

## Staging, serialization and revalidation

Use a dedicated app-private Updates directory and fixed self-owned filenames. Download to a partial file, stream the digest, enforce both signed byte count and the absolute cap, flush, verify, then atomically commit. Cache the raw manifest and signature with the ready state. A local marker/JSON file alone cannot authorize an executable.

Serialize check/prepare/install and cleanup using a shared per-process lock/manager across all instances; Android Provider validation and opening must be under that same lock. Immediately before installation, reverify signed manifest, newer build, exact channel, package length and actual SHA-256. Android additionally checks the actual APK archive's package ID, versionCode equal to the signed build, embedded channel and signing certificate matching the installed new application. A null/unavailable certificate query is a refusal unless a tested compatible query provides the certificate; never bypass identity validation.

No partial/corrupt download may be executed. A failed attempt must not delete unrelated files or authorize another path. A canceled/failed installation retains its verified package and pending state for retry. Only self-owned partial downloads proven invalid may be discarded without installation success.

## Installation success and cleanup

**Windows:** copy the trusted current application into a fixed helper location. Before the old app exits, the helper acquires its parent-process handle and true executable path, verifies staging and acknowledges initialization. After the parent/host exit, revalidate staging again and invoke the verified installer silently with `/D=<current executable directory>` **last**. Wait for completion. Exit code zero alone is insufficient: verify the installed main executable against the signed `installed_sha256` and intended build. Only then clean its managed downloaded package/state and restart that exact installed executable. A failed helper handshake, installer failure, missing/replaced executable or mismatching hash retains the package and reports failure. Default fresh installation remains `E:\SpektraLab`.

**Android:** request unknown-source permission if needed, then open the OS installer using the narrowly scoped read-only content Provider or PackageInstaller flow. Ordinary Android requires user confirmation. Keep a pending record of target build, channel and signing identity. On OS success/restart, reconcile PackageManager's actually installed versionCode, channel and signing identity against the signed target; only a confirmed installation at or beyond that target permits removal of the fixed managed package/state. Cancel, denied permission, installer launch or a pending UI intent is never success. Never remove the old application's package/data.

## Validation and publication gate

Use the same replacement public key and signed byte fixtures on both native implementations. Include positive future-build verification and negative signature/tampering/schema/integer/channel/URL/name/digest/size/downgrade cases. Verify real packaged public-key bytes, APK archive identity behavior, refusal paths, unrelated-file preservation, Windows handshake/hash proof and Android cancellation/cleanup behavior. Fixture cleanup success is not proof that an OS upgrade occurred.

Only this recovery build's actually executed checks belong in `FINAL-VALIDATION.json`; old results are historical. Record mock/browser, Linux Vulkan, Wine, Android emulator and physical-device scopes separately. Hash final installers/APKs, corresponding source and receipts, persist them externally, and verify readback before treating delivery as complete. Do not publish untested packages or claim an empty draft Release is an available update.
