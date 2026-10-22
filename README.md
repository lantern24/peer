# Peer

A local, read-only repository viewer and review workspace. Browse code and diffs, leave review comments, and copy feedback for your coding agent. Peer never edits, stages, commits, fetches, or applies changes to your repositories.

https://github.com/user-attachments/assets/d1520c86-ff5a-4d7e-8fa6-cd24cf1b46d9

Licensed under [Apache-2.0](LICENSE). Bundled dependencies and themes retain their [third-party notices](THIRD_PARTY_NOTICES.md).

## Install with Homebrew

Requirements: [Homebrew](https://brew.sh/), an Apple Silicon Mac (arm64), and macOS 13 or later. Intel Macs are not supported by the current release bundle. Git is required; Homebrew installs it automatically. Node.js and Rust are not needed to run Peer, though optional code-navigation servers require their own toolchains.

```sh
brew update
brew install --cask lantern24/tap/peer
```

The fully qualified cask name adds the [Lantern24 tap](https://github.com/lantern24/homebrew-tap) automatically; a separate `brew tap` command is not needed. Homebrew downloads the published release ZIP, verifies its SHA-256 checksum, installs `Peer.app` into `/Applications` by default, and installs Git as a runtime dependency.

Automatic repository-change monitoring requires Git 2.42+; manual refresh remains available with older versions. If Peer cannot find Git, set its executable path in Settings → Git.

### First launch on macOS

Current releases are ad-hoc signed, not Developer ID signed or notarized by Apple. A valid signature protects bundle integrity but does not make Gatekeeper trust the app; Homebrew installation does not remove this distinction.

1. Open **Peer** from Applications or Spotlight.
2. If macOS blocks the launch because the developer cannot be verified, and you trust the download, open **System Settings → Privacy & Security** and scroll to **Security**.
3. Choose **Open Anyway** for Peer, if available, and confirm **Open** in the next dialog.

See [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Managed Macs may prohibit this exception. Do not disable Gatekeeper globally or bypass a malware warning.

### Upgrade

```sh
brew update
brew upgrade --cask lantern24/tap/peer
```

Quit Peer before upgrading, then reopen it afterward.

If you installed v0.1.0 and macOS reports the app as damaged, upgrade to v0.1.1 or later: v0.1.0 had an invalid bundle signature. The integrity fix does not add notarization. If a newer version still reports damage, [report the problem](https://github.com/lantern24/peer/issues) rather than treating it as an ordinary unidentified-developer warning.

### Uninstall

```sh
brew uninstall --cask lantern24/tap/peer
```

This removes the app bundle; saved review data and preferences are retained.

## Install on Linux

Requirements: [Homebrew on Linux](https://docs.brew.sh/Homebrew-on-Linux) and an x86_64 (amd64) Linux system. Linux release builds use Ubuntu 22.04 as the build baseline; Linux ARM builds are not included.

```sh
brew update
brew install --formula lantern24/tap/peer
```

The fully qualified formula name adds the [Lantern24 tap](https://github.com/lantern24/homebrew-tap) automatically; a separate `brew tap` command is not needed. Launch Peer by running `peer`.

Git is required. Automatic repository-change monitoring requires Git 2.42+; manual refresh remains available with older versions. Node.js and Rust are not required to run Peer, though optional code-navigation servers require their own toolchains.

## Documentation

- [User manual](docs/USER_MANUAL.md): review workflow, code navigation, themes, diagnostic reports, and saved-data limits.
- [Contributor guide](AGENTS.md): development, builds, releases, architecture, and validation.
