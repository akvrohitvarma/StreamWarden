#!/usr/bin/env python3
"""StreamWarden — IPTV Stream Manager"""

import atexit
import hashlib
import json
import logging
import platform
import re
import subprocess
import threading
import webbrowser
from pathlib import Path

import requests
from flask import Flask, jsonify, request as req, send_from_directory

from client import (
    StalkerClient, load_config, save_config, DEFAULT_CONFIG, DOWNLOAD_DIR,
    get_config_path, set_config_path,
)

LOG = logging.getLogger("streamwarden")

# ---------------------------------------------------------------------------
# Tool detection
# ---------------------------------------------------------------------------

def _detect_ytdlp():
    local = Path(__file__).resolve().parent / "env" / "bin" / "yt-dlp"
    if local.exists():
        return str(local)
    local_win = Path(__file__).resolve().parent / "env" / "Scripts" / "yt-dlp.exe"
    if local_win.exists():
        return str(local_win)
    return "yt-dlp"


def _detect_ffmpeg():
    local = Path(__file__).resolve().parent / "env" / "bin" / "ffmpeg"
    if local.exists():
        return str(local)
    local_win = Path(__file__).resolve().parent / "env" / "Scripts" / "ffmpeg.exe"
    if local_win.exists():
        return str(local_win)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return "ffmpeg"


# ---------------------------------------------------------------------------
# Flask App
# ---------------------------------------------------------------------------

config = load_config()
client = None
profile_data = None

app = Flask(__name__, static_folder="static")
app.config["JSONIFY_PRETTYPRINT_REGULAR"] = False

downloads_in_progress = {}
_child_procs = []
_caffeinate_proc = None


def _start_caffeinate():
    global _caffeinate_proc
    if platform.system() != "Darwin" or _caffeinate_proc is not None:
        return
    try:
        _caffeinate_proc = subprocess.Popen(
            ["caffeinate", "-dims"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        pass


def _stop_caffeinate():
    global _caffeinate_proc
    if _caffeinate_proc:
        try:
            _caffeinate_proc.terminate()
        except Exception:
            pass
        _caffeinate_proc = None


def _cleanup_children():
    _stop_caffeinate()
    for p in _child_procs:
        try:
            p.terminate()
        except Exception:
            pass
    for p in _child_procs:
        try:
            p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    _child_procs.clear()


atexit.register(_cleanup_children)


def get_client():
    global client, profile_data
    if client is None:
        client = StalkerClient(config)
        profile_data = client.auth()
    return client


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/connect", methods=["POST"])
def api_connect():
    global client, profile_data
    try:
        client = StalkerClient(config)
        profile_data = client.auth()
        return jsonify({"ok": True, "profile": {
            "fname": profile_data.get("fname", ""),
            "mac": config.get("mac", ""),
            "expire": profile_data.get("expire_billing_date", ""),
        }})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/categories")
def api_categories():
    try:
        return jsonify({"ok": True, "data": get_client().categories()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/vod")
def api_vod():
    cat = req.args.get("cat", "*")
    page = int(req.args.get("page", 1))
    search = req.args.get("search", "").strip() or None
    try:
        return jsonify({"ok": True, "data": get_client().vod_list(cat, page, search)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/movie/<mid>")
def api_movie(mid):
    try:
        return jsonify({"ok": True, "data": get_client().movie_files(mid)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/seasons/<mid>")
def api_seasons(mid):
    try:
        return jsonify({"ok": True, "data": get_client().seasons(mid)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/episodes/<mid>/<sid>")
def api_episodes(mid, sid):
    try:
        return jsonify({"ok": True, "data": get_client().episodes(mid, sid)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/episode_files/<mid>/<sid>/<eid>")
def api_episode_files(mid, sid, eid):
    try:
        data = get_client().episode_files(mid, sid, eid)
        files = data.get("data", [])
        url = ""
        name = ""
        if files:
            f = files[0]
            url = f.get("cmd", "")
            name = f.get("name", "")
        return jsonify({"ok": True, "url": url, "name": name, "files": files})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/stream/<fid>")
def api_stream(fid):
    try:
        url = get_client().create_link(fid)
        return jsonify({"ok": True, "url": url})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/probe")
def api_probe():
    url = req.args.get("url", "")
    if not url:
        return jsonify({"ok": False, "error": "No URL"})
    ytdlp = _detect_ytdlp()
    ffmpeg = _detect_ffmpeg()
    fallback = {"ok": True, "vcodec": "unknown", "acodec": "unknown", "ext": "mp4", "native": "mp4", "qualities": [], "subtitles": []}
    try:
        r = subprocess.run(
            [ytdlp, "--no-warnings", "--ffmpeg-location", ffmpeg, "-j", url],
            capture_output=True, text=True, timeout=25
        )
        if r.returncode != 0:
            return jsonify(fallback)
        info = json.loads(r.stdout)
        vcodec = info.get("vcodec", "unknown") or "unknown"
        acodec = info.get("acodec", "unknown") or "unknown"
        ext = info.get("ext", "mp4") or "mp4"
        native = ext
        if ext in ("m3u8", "m3u8_native"):
            native = "mkv" if any(x in vcodec for x in ("hevc", "h265", "hev1")) else "mp4"
        elif ext in ("mpegts", "ts"):
            native = "ts"

        qualities = []
        seen = set()
        fmts = info.get("formats", [])
        for f in fmts:
            h = f.get("height")
            if not h or h in seen:
                continue
            seen.add(h)
            tbr = f.get("tbr") or f.get("vbr") or 0
            vc = f.get("vcodec", "") or ""
            ac = f.get("acodec", "") or ""
            fid = f.get("format_id", "")
            label = f"{h}p"
            if h >= 2160:
                label = "4K (2160p)"
                tier = "best"
            elif h >= 1080:
                label = f"1080p {'(Full HD)' if h == 1080 else ''}"
                tier = "best" if h > 1080 else "high"
            elif h >= 720:
                label = "720p (HD)"
                tier = "good"
            elif h >= 480:
                label = "480p (SD)"
                tier = "medium"
            else:
                label = f"{h}p"
                tier = "low"
            qualities.append({
                "format_id": fid, "height": h, "label": label.strip(),
                "bitrate_kbps": int(tbr) if tbr else None,
                "vcodec": vc.split(".")[0] if vc else "",
                "tier": tier,
            })
        qualities.sort(key=lambda q: q["height"], reverse=True)

        if not qualities:
            h = info.get("height")
            if h:
                qualities.append({
                    "format_id": "best", "height": h,
                    "label": f"{h}p (single stream)", "bitrate_kbps": int(info.get("tbr", 0)) or None,
                    "vcodec": vcodec.split(".")[0], "tier": "best",
                })

        subs = []
        sub_dict = info.get("subtitles", {})
        auto_dict = info.get("automatic_captions", {})
        for lang, entries in sub_dict.items():
            name = entries[0].get("name", lang) if entries else lang
            subs.append({"lang": lang, "name": str(name), "auto": False})
        for lang, entries in auto_dict.items():
            if lang not in sub_dict:
                name = entries[0].get("name", lang) if entries else lang
                subs.append({"lang": lang, "name": str(name), "auto": True})
        subs.sort(key=lambda s: (s["auto"], s["lang"]))

        return jsonify({"ok": True, "vcodec": vcodec, "acodec": acodec, "ext": ext,
                        "native": native, "qualities": qualities, "subtitles": subs})
    except subprocess.TimeoutExpired:
        return jsonify(fallback)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/tv_genres")
def api_tv_genres():
    try:
        return jsonify({"ok": True, "data": get_client().tv_genres()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/tv")
def api_tv():
    genre = req.args.get("genre", "*")
    page = int(req.args.get("page", 1))
    try:
        return jsonify({"ok": True, "data": get_client().tv_channels(genre, page)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


def _vlc_play(vlc_path, url, title="Stream"):
    args = [vlc_path, "--one-instance", url,
            f"--meta-title={title}", "--no-video-title-show"]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@app.route("/api/tv_play", methods=["POST"])
def api_tv_play():
    cmd = req.json.get("cmd", "")
    name = req.json.get("name", "Channel")
    try:
        url = get_client().tv_link(cmd)
        if not url:
            return jsonify({"ok": False, "error": "No stream URL"})
        vlc = config.get("vlc_path", "")
        if vlc and Path(vlc).exists():
            _vlc_play(vlc, url, name)
            return jsonify({"ok": True, "url": url, "player": "vlc"})
        return jsonify({"ok": True, "url": url, "player": "none"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/poster")
def api_poster():
    path = req.args.get("path", "")
    if not path:
        return ("", 404)
    portal = config.get("portal_url", "")
    if not portal:
        return ("", 404)
    base = portal.split("/stalker_portal")[0] if "/stalker_portal" in portal else portal.rsplit("/", 1)[0]
    url = base + path if path.startswith("/") else base + "/" + path
    try:
        r = requests.get(url, timeout=10, stream=True)
        if r.status_code != 200:
            return ("", 404)
        ct = r.headers.get("Content-Type", "image/jpeg")
        return (r.content, 200, {"Content-Type": ct, "Cache-Control": "public, max-age=86400"})
    except Exception:
        return ("", 404)


@app.route("/api/encoders")
def api_encoders():
    ffmpeg = _detect_ffmpeg()
    hw = _list_hw_encoders(ffmpeg)
    return jsonify({"ok": True, "hardware": hw, "platform": platform.system()})


@app.route("/api/play", methods=["POST"])
def api_play():
    url = req.json.get("url", "")
    name = req.json.get("name", "Stream")
    vlc = config.get("vlc_path", "")
    if vlc and Path(vlc).exists():
        _vlc_play(vlc, url, name)
        return jsonify({"ok": True, "player": "vlc"})
    return jsonify({"ok": True, "player": "none", "url": url})


# ---------------------------------------------------------------------------
# Hardware encoder detection
# ---------------------------------------------------------------------------

def _list_hw_encoders(ffmpeg_path):
    found = []
    try:
        r = subprocess.run([ffmpeg_path, "-encoders"], capture_output=True, text=True, timeout=5)
        out = r.stdout
        if "h264_videotoolbox" in out:
            found.append({"id": "h264_videotoolbox", "name": "VideoToolbox", "platform": "macOS", "desc": "Apple GPU/Media Engine"})
        if "h264_nvenc" in out:
            found.append({"id": "h264_nvenc", "name": "NVENC", "platform": "Windows/Linux", "desc": "NVIDIA GPU"})
        if "h264_amf" in out:
            found.append({"id": "h264_amf", "name": "AMF", "platform": "Windows", "desc": "AMD GPU"})
        if "h264_qsv" in out:
            found.append({"id": "h264_qsv", "name": "QSV", "platform": "Windows/Linux", "desc": "Intel iGPU/dGPU"})
    except Exception:
        pass
    return found


def _has_hw_encoder(ffmpeg_path):
    encs = _list_hw_encoders(ffmpeg_path)
    return encs[0]["id"] if encs else None


def _get_duration(ffmpeg_path, filepath):
    try:
        r = subprocess.run(
            [ffmpeg_path, "-i", str(filepath)],
            capture_output=True, text=True, timeout=10
        )
        m = re.search(r'Duration:\s*(\d+):(\d+):([\d.]+)', r.stderr)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return 0


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

@app.route("/api/download", methods=["POST"])
def api_download():
    url = req.json.get("url", "")
    name = req.json.get("name", "untitled")
    fmt = req.json.get("format", "mp4")
    if fmt not in ("mp4", "mkv", "ts", "mp4-compat"):
        fmt = "mp4"
    safe = re.sub(r'[<>:"/\\|?*]', '_', name)[:200]
    out_dir = Path(config.get("download_dir", str(DOWNLOAD_DIR)))
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = "mp4" if fmt == "mp4-compat" else fmt
    fp = out_dir / f"{safe}.{ext}"
    ytdlp = _detect_ytdlp()
    ffmpeg = _detect_ffmpeg()
    dl_id = hashlib.md5((url + fmt).encode()).hexdigest()[:8]

    quality = req.json.get("quality", "best")
    if quality == "best":
        fmt_sel = "bestvideo+bestaudio/best"
    else:
        fmt_sel = f"bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best"

    sub_langs = req.json.get("subtitles", [])

    is_reencode = fmt == "mp4-compat"
    fmt_label = "MP4 (H.264)" if is_reencode else ext.upper()

    def _parse_dl_progress(line, entry):
        if "%" in line and ("of" in line or "frag" in line):
            m = re.search(r'([\d.]+)%', line)
            if m:
                entry["percent"] = float(m.group(1))
            sp = re.search(r'at\s+([\d.]+\s*\S+/s)', line)
            if sp:
                entry["speed"] = sp.group(1)
            eta_m = re.search(r'ETA\s+(\S+)', line)
            if eta_m:
                entry["eta"] = eta_m.group(1)

    encoder_pref = config.get("encoder", "auto")

    def _enc_args_for(enc_id):
        m = {
            "h264_videotoolbox": ["-c:v", "h264_videotoolbox", "-q:v", "55", "-profile:v", "high"],
            "h264_nvenc":        ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "20", "-profile:v", "high"],
            "h264_amf":          ["-c:v", "h264_amf", "-quality", "quality", "-profile:v", "high"],
            "h264_qsv":          ["-c:v", "h264_qsv", "-global_quality", "20", "-profile:v", "high"],
        }
        return m.get(enc_id, ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-profile:v", "high"])

    def _pick_encoder():
        if encoder_pref == "software":
            return _enc_args_for("libx264")
        if encoder_pref in ("h264_videotoolbox", "h264_nvenc", "h264_amf", "h264_qsv"):
            return _enc_args_for(encoder_pref)
        hw = _has_hw_encoder(ffmpeg)
        if encoder_pref == "hardware" and hw:
            return _enc_args_for(hw)
        if encoder_pref == "auto" and hw:
            return _enc_args_for(hw)
        return _enc_args_for("libx264")

    def run():
        _start_caffeinate()
        enc_args = _pick_encoder()
        hw_tags = {"videotoolbox": "VideoToolbox", "nvenc": "NVENC", "amf": "AMF", "qsv": "QSV"}
        enc_name = "Software (libx264)"
        for tag, label in hw_tags.items():
            if any(tag in a for a in enc_args):
                enc_name = label
                break
        label_suffix = f" [{enc_name}]" if is_reencode else ""
        entry = {"name": f"{name} (.{fmt_label}){label_suffix}", "status": "downloading", "phase": "download",
                 "path": str(fp), "percent": 0, "speed": "", "eta": "", "encoder": enc_name if is_reencode else ""}
        downloads_in_progress[dl_id] = entry

        try:
            sub_args = []
            if sub_langs:
                langs = ",".join(sub_langs)
                sub_args = ["--write-sub", "--sub-lang", langs, "--convert-subs", "srt"]

            if is_reencode:
                raw_fp = out_dir / f"{safe}_raw.mkv"
                dl_cmd = [ytdlp, "--no-warnings", "--newline", "--ffmpeg-location", ffmpeg,
                          "-f", fmt_sel, "--merge-output-format", "mkv",
                          "--postprocessor-args", "ffmpeg:-c copy",
                          *sub_args,
                          "-o", str(raw_fp), url]
                proc = subprocess.Popen(dl_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                _child_procs.append(proc)
                for line in proc.stdout:
                    _parse_dl_progress(line.strip(), entry)
                proc.wait()
                if proc in _child_procs:
                    _child_procs.remove(proc)
                if proc.returncode != 0:
                    entry["status"] = "error: download failed (exit " + str(proc.returncode) + ")"
                    _check_stop_caffeinate()
                    return

                entry["phase"] = "transcoding"
                entry["status"] = "transcoding"
                entry["percent"] = 0
                entry["speed"] = ""
                entry["eta"] = ""

                duration = _get_duration(ffmpeg, raw_fp)

                ff_cmd = [ffmpeg, "-y", "-i", str(raw_fp), "-progress", "pipe:1",
                          *enc_args, "-c:a", "aac", "-b:a", "192k",
                          "-movflags", "+faststart", str(fp)]
                ff_proc = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                _child_procs.append(ff_proc)
                for line in ff_proc.stdout:
                    line = line.strip()
                    if line.startswith("out_time_us="):
                        try:
                            us = int(line.split("=")[1])
                            secs = us / 1_000_000
                            if duration > 0:
                                entry["percent"] = min(99, round(secs / duration * 100, 1))
                            entry["eta"] = f"{int(secs)}s / {int(duration)}s" if duration > 0 else f"{int(secs)}s"
                        except (ValueError, IndexError):
                            pass
                    elif line.startswith("speed=") and line != "speed=N/A":
                        entry["speed"] = line.split("=")[1].strip()
                ff_proc.wait()
                if ff_proc in _child_procs:
                    _child_procs.remove(ff_proc)

                if ff_proc.returncode == 0:
                    entry["status"] = "done"
                    entry["percent"] = 100
                    entry["phase"] = "done"
                    try:
                        raw_fp.unlink()
                    except OSError:
                        pass
                else:
                    entry["status"] = f"error: transcode failed (exit {ff_proc.returncode})"
            else:
                dl_cmd = [ytdlp, "--no-warnings", "--newline", "--ffmpeg-location", ffmpeg,
                          "-f", fmt_sel, *sub_args, "-o", str(fp)]
                if fmt == "mp4":
                    dl_cmd += ["--merge-output-format", "mp4",
                               "--postprocessor-args", "ffmpeg:-c copy -movflags +faststart"]
                elif fmt == "mkv":
                    dl_cmd += ["--merge-output-format", "mkv",
                               "--postprocessor-args", "ffmpeg:-c copy"]
                elif fmt == "ts":
                    dl_cmd += ["--merge-output-format", "mpegts",
                               "--postprocessor-args", "ffmpeg:-c copy"]
                dl_cmd.append(url)
                proc = subprocess.Popen(dl_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                _child_procs.append(proc)
                for line in proc.stdout:
                    line = line.strip()
                    _parse_dl_progress(line, entry)
                    if "[Merger]" in line or "[ffmpeg]" in line:
                        entry["phase"] = "muxing"
                        entry["status"] = "muxing"
                proc.wait()
                if proc in _child_procs:
                    _child_procs.remove(proc)
                if proc.returncode == 0:
                    entry["status"] = "done"
                    entry["percent"] = 100
                    entry["phase"] = "done"
                    for tmp in out_dir.glob(f"{safe}.temp.*"):
                        try:
                            tmp.unlink()
                        except OSError:
                            pass
                else:
                    entry["status"] = "error: yt-dlp exit code " + str(proc.returncode)
        except Exception as e:
            entry["status"] = f"error: {e}"
        finally:
            _check_stop_caffeinate()

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"ok": True, "id": dl_id, "path": str(fp)})


def _check_stop_caffeinate():
    active = [d for d in downloads_in_progress.values()
              if d.get("status") in ("downloading", "transcoding", "muxing")]
    if not active:
        _stop_caffeinate()


@app.route("/api/download_status")
def api_download_status():
    return jsonify({"ok": True, "downloads": downloads_in_progress})


@app.route("/api/downloads_list")
def api_downloads_list():
    dl_dir = Path(config.get("download_dir", str(DOWNLOAD_DIR)))
    if not dl_dir.exists():
        return jsonify({"ok": True, "files": []})
    all_files = []
    for pattern in ("*.mp4", "*.mkv", "*.ts", "*.srt"):
        all_files.extend(dl_dir.glob(pattern))
    all_files = [f for f in all_files if not f.stem.endswith("_raw") and ".temp." not in f.name and not f.name.endswith(".part")]
    files = sorted(all_files, key=lambda f: f.stat().st_mtime, reverse=True)
    return jsonify({"ok": True, "files": [
        {"name": f.name, "size_mb": round(f.stat().st_size / 1048576, 1), "path": str(f)}
        for f in files[:100]
    ]})


@app.route("/api/config", methods=["GET"])
def api_config_get():
    return jsonify({"ok": True, "config": config})


@app.route("/api/config", methods=["POST"])
def api_config_set():
    global client, profile_data
    data = req.json
    for k in DEFAULT_CONFIG:
        if k in data:
            config[k] = data[k]
    save_config(config)
    client = None
    profile_data = None
    return jsonify({"ok": True})


@app.route("/api/config_path")
def api_config_path():
    return jsonify({"ok": True, "path": str(get_config_path())})


@app.route("/api/config_path", methods=["POST"])
def api_config_path_set():
    global config, client, profile_data
    new_dir = req.json.get("path", "")
    if not new_dir:
        return jsonify({"ok": False, "error": "No path provided"})
    try:
        set_config_path(new_dir)
        config = load_config()
        client = None
        profile_data = None
        return jsonify({"ok": True, "path": str(get_config_path())})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/detect_defaults", methods=["POST"])
def api_detect_defaults():
    from client import _detect_vlc, DOWNLOAD_DIR
    return jsonify({
        "ok": True,
        "vlc_path": _detect_vlc(),
        "download_dir": str(DOWNLOAD_DIR),
    })


@app.route("/api/pick_folder", methods=["POST"])
def api_pick_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(
            title="Choose Download Folder",
            initialdir=config.get("download_dir", str(DOWNLOAD_DIR))
        )
        root.destroy()
        if folder:
            return jsonify({"ok": True, "path": folder})
        return jsonify({"ok": False, "error": "cancelled"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.WARNING)
    port = 7899
    url = f"http://localhost:{port}"
    print(f"\n  StreamWarden running at {url}\n")
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
