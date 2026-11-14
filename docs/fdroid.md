# Publishing on F-Droid

This is where Bever stands against what F-Droid asks of an application, written for whoever submits it. Nothing here has been tried on F-Droid's build server; the open points are the ones to settle first.

## What is in order

- **Licence.** The source is GPL-3.0-or-later. The bundled text-recognition models are data under CC BY-SA 4.0, with their origin given in `crates/bever-core/models/README.md`.
- **No tracking, advertising, or proprietary libraries.** There is no analytics, crash reporting, or advertising, and no Google Play Services or Firebase. The application does not update itself and does not download code.
- **Network use is the user's choice.** The only requests are to pCloud, after the user has connected an account, and to websites whose images the user asks to see in a note.
- **Application ID.** `io.github.balakrishnangithub.bever`, which belongs to the repository's owner.
- **Versions.** Each release is tagged `v<version>`. The version code is derived from the version (`1.0.0` is `1000000`) and grows with it.
- **Listing.** Title, descriptions, icon, screenshots, and a changelog for each version code are in `fastlane/metadata/android/en-US`, where F-Droid reads them.
- **Backup.** `allowBackup` is off, so nothing is copied to a Google account.

## What F-Droid will mark

- **NonFreeNet.** Synchronization uses pCloud, a proprietary service. It is optional and off until the user connects an account, but it is the only service offered, so the listing carries this anti-feature until a free one (WebDAV, for instance) is added.

## What is still open

1. **The build has not been run on Linux.** Releases so far were built on Windows. F-Droid builds on Debian, from source, without this repository's `gen/` folder: the Android project is created by `npm run android:init` and the maintained sources in `src-tauri/android` are copied over it. That sequence has to be shown to work there.
2. **Build tools that arrive as binaries.** `npm ci` installs the Tauri CLI, and the bundler used by Vite, as prebuilt programs. F-Droid wants tools built from source or taken from Debian; the Tauri CLI can be built with `cargo install tauri-cli --locked`, and the recipe has to use that instead of the npm package. Whether the bundler's binary is accepted is for F-Droid's reviewers to say.
3. **Rust and the NDK** are not in F-Droid's build image and have to be installed by the recipe (`rustup` with the Android targets, and an NDK named in `ndk:`).
4. **Signatures.** F-Droid signs what it builds with its own key. The APK attached to GitHub releases is signed with a debug key, so one cannot be installed over the other; people moving to the F-Droid build have to uninstall first, which removes the notes on the device. Export or synchronize before that. A release key and reproducible builds would let F-Droid publish the developer's signature instead.
5. **Not run on a device.** The Android build is compiled and packaged for each release. Its file pickers, opening of attachments, the keyboard, and the synchronization notification have not been checked on a phone as part of the release.
6. **The pCloud client identifier** in the source belongs to the application registered by the developer. It is not a secret (the implicit flow has none), but a build by someone else uses the same registration.

## A recipe to start from

Untested, and to be corrected against the first build log:

```yaml
Categories:
  - Writing
License: GPL-3.0-or-later
SourceCode: https://github.com/balakrishnangithub/bever
IssueTracker: https://github.com/balakrishnangithub/bever/issues
Changelog: https://github.com/balakrishnangithub/bever/blob/main/CHANGELOG.md

AutoName: Bever
AntiFeatures:
  NonFreeNet:
    en-US: Synchronization, which is optional, uses pCloud.

RepoType: git
Repo: https://github.com/balakrishnangithub/bever.git

Builds:
  - versionName: 1.1.2
    versionCode: 1001002
    commit: v1.1.2
    sudo:
      - apt-get update
      - apt-get install -y nodejs npm build-essential
    init:
      - curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
      - $HOME/.cargo/bin/rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
      - $HOME/.cargo/bin/cargo install tauri-cli --locked
    output: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
    build:
      - export PATH=$HOME/.cargo/bin:$PATH
      - npm ci --ignore-scripts
      - npm run build
      - cargo tauri android init
      - node scripts/sync-android-source.cjs
      - cargo tauri android build --apk
    ndk: r26d

AutoUpdateMode: Version
UpdateCheckMode: Tags
CurrentVersion: 1.1.2
CurrentVersionCode: 1001002
```
