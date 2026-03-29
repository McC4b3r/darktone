# Darktone Player

Darktone Player is a local-first desktop music player built with `Tauri 2`, `React`, `TypeScript`, and `Vite`. The first version is designed as a refined reinterpretation of the `foobar2000 DarkOne v4` mood: dense, dark, keyboard-friendly, and focused on fast browsing of local music folders.

## Features

- Cross-platform desktop architecture for macOS, Windows, and Linux
- Local folder scanning for `mp3` and `wav`
- Persistent music library and app settings
- Artist and album browsing with compact track tables
- Queue management with reorder and remove actions
- Play/pause, previous/next, seek, volume, mute, shuffle, repeat-all, and repeat-one
- Search across artist, album, track title, and filename
- Keyboard shortcuts:
  - `Cmd/Ctrl + O` add folder
  - `Cmd/Ctrl + F` focus search
  - `Space` play/pause
  - `Left/Right Arrow` previous/next

## Project Structure

- `src/` React application, playback state, and UI
- `src-tauri/` Rust commands for folder selection, scanning, metadata extraction, and persistence

## Run Locally

1. Install Node.js 20+.
2. Install Rust and Cargo from [rustup.rs](https://rustup.rs/).
3. Install system prerequisites for Tauri for your OS.
4. Install frontend dependencies:

```bash
pnpm install
```

5. Start the frontend only:

```bash
pnpm dev
```

6. Start the desktop app:

```bash
pnpm tauri:dev
```

## Verify

```bash
pnpm test
pnpm build
```

## Current Note

The frontend build and tests are validated in this workspace. The Tauri/Rust shell is scaffolded and wired, but compiling the desktop binary in this environment requires a Rust toolchain to be installed first.
