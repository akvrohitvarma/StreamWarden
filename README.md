# StreamWarden

A cross-platform web-based tool for browsing, streaming, and downloading VOD content from Stalker/Ministra IPTV portals.

![Python](https://img.shields.io/badge/Python-3.9+-blue)
![Flask](https://img.shields.io/badge/Flask-Web_UI-green)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## Features

- **VOD Browser** — Browse movies and series by category with poster artwork, search, and pagination
- **Series Navigation** — Full season/episode browser with batch selection for downloading or streaming
- **Live TV** — Browse and stream live channels by genre
- **Stream in VLC** — One-click playback in VLC media player
- **Download Manager** — Download VOD content with real-time progress tracking
- **Format Picker** — Choose between native format (MKV/MP4/TS) or re-encoded H.264 for universal compatibility
- **Quality Selection** — Pick from available stream qualities (Best, 1080p, 720p, 480p)
- **Hardware-Accelerated Encoding** — Auto-detects and uses VideoToolbox (macOS), NVENC (NVIDIA), AMF (AMD), or QSV (Intel)
- **Subtitle Support** — Download available subtitles alongside video files
- **Cross-Platform** — Runs on macOS, Windows, and Linux

## Screenshots

The app runs as a local web server with a modern dark-themed UI accessible from any browser.

## Quick Start

### 1. Clone and set up the virtual environment

```bash
git clone https://github.com/yourusername/StreamWarden.git
cd StreamWarden

python3 -m venv env
source env/bin/activate        # macOS/Linux
# env\Scripts\activate         # Windows
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Set up ffmpeg (stays inside the venv)

```bash
# The imageio-ffmpeg package bundles a static ffmpeg binary.
# Create a symlink so yt-dlp can find it:
ln -s "$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" env/bin/ffmpeg
```

### 4. Run

```bash
python app.py
```

The app opens automatically at `http://localhost:7899`.

## Configuration

On first launch, go to **Settings** and enter:

| Field | Description |
|-------|-------------|
| **Portal URL** | Your IPTV provider's portal address (e.g., `http://example.com/stalker_portal`) |
| **MAC Address** | Your device MAC address (provided by your IPTV service) |
| **STB Model** | Set-top box model to emulate (dropdown) |

Additional settings for serial number, hardware version, encoder preference, download folder (with native OS folder picker), and VLC path are available.

Configuration is stored at `~/.streamwarden/config.json`.

## Download Formats

| Format | Description |
|--------|-------------|
| **Native (.MKV/.MP4/.TS)** | Original codec, fastest download, full quality. May require VLC to play. |
| **.MP4 (H.264)** | Re-encoded to H.264 + AAC. Plays natively in QuickTime (macOS) and Windows. Near-lossless quality. |

When using H.264 re-encoding, StreamWarden automatically detects and uses hardware encoders for significantly faster transcoding.

## Tech Stack

- **Python** + **Flask** — Backend and web server
- **yt-dlp** — HLS stream downloading and probing
- **ffmpeg** — Media transcoding (via `imageio-ffmpeg`)
- **Stalker/Ministra API** — IPTV portal communication

## Requirements

- Python 3.9+
- An active IPTV subscription with a Stalker/Ministra-based portal
- VLC media player (optional, for streaming)

## License

MIT
