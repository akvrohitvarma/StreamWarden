"""StreamWarden — Stalker/Ministra IPTV API client and configuration."""

import hashlib
import json
import os
import platform
import time
from pathlib import Path

import requests

APP_DIR = Path(__file__).resolve().parent
_CONFIG_PATH_FILE = APP_DIR / ".streamwarden_path"
DOWNLOAD_DIR = Path.home() / "Downloads" / "StreamWarden"


def _resolve_config_file():
    if _CONFIG_PATH_FILE.exists():
        try:
            stored = _CONFIG_PATH_FILE.read_text().strip()
            if stored:
                p = Path(stored)
                if p.is_dir():
                    return p / "config.json"
                return p
        except (IOError, OSError):
            pass
    return APP_DIR / "config.json"


def get_config_path():
    return _resolve_config_file()


def set_config_path(new_dir):
    old_file = _resolve_config_file()
    new_file = Path(new_dir) / "config.json"
    Path(new_dir).mkdir(parents=True, exist_ok=True)
    if old_file.exists() and old_file != new_file:
        import shutil
        shutil.copy2(str(old_file), str(new_file))
        old_file.unlink()
    _CONFIG_PATH_FILE.write_text(str(new_file))
    return new_file

DEFAULT_CONFIG = {
    "portal_url": "",
    "mac": "",
    "serial": "",
    "device": "MAG250",
    "hw_version": "1.7-BD-00",
    "image_version": "216",
    "api_signature": "262",
    "download_dir": str(DOWNLOAD_DIR),
    "vlc_path": "",
    "encoder": "auto",
}


def _detect_vlc():
    if platform.system() == "Darwin":
        p = "/Applications/VLC.app/Contents/MacOS/VLC"
        if Path(p).exists():
            return p
    elif platform.system() == "Windows":
        for base in [os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")]:
            if base:
                p = Path(base) / "VideoLAN" / "VLC" / "vlc.exe"
                if p.exists():
                    return str(p)
    else:
        for p in ["/usr/bin/vlc", "/snap/bin/vlc", "/usr/local/bin/vlc"]:
            if Path(p).exists():
                return p
    return ""


def load_config():
    cfg_file = _resolve_config_file()
    cfg_file.parent.mkdir(parents=True, exist_ok=True)
    if cfg_file.exists():
        try:
            with open(cfg_file) as f:
                cfg = {**DEFAULT_CONFIG, **json.load(f)}
                if not cfg.get("vlc_path"):
                    cfg["vlc_path"] = _detect_vlc()
                return cfg
        except (json.JSONDecodeError, IOError):
            pass
    cfg = dict(DEFAULT_CONFIG)
    cfg["vlc_path"] = _detect_vlc()
    return cfg


def save_config(cfg):
    cfg_file = _resolve_config_file()
    cfg_file.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_file, "w") as f:
        json.dump(cfg, f, indent=2)


class StalkerClient:
    UA = (
        "Mozilla/5.0 (QtEmbedded; U; Linux; C) "
        "AppleWebKit/533.3 (KHTML, like Gecko) "
        "MAG200 stbapp ver: 2 rev: 250 Safari/533.3"
    )

    def __init__(self, cfg):
        self.cfg = cfg
        self.s = requests.Session()
        self.token = None
        self._setup()

    def _setup(self):
        portal = self.cfg.get("portal_url", "")
        if not portal:
            return
        dev = self.cfg.get("device", "AuraHD9")
        self.s.headers.update({
            "User-Agent": self.UA,
            "X-User-Agent": f"Model: {dev}; Link: WiFi",
            "Referer": f"{portal}/c/",
            "Cache-Control": "no-cache",
        })
        mac = self.cfg.get("mac", "")
        try:
            dom = portal.split("//")[1].split("/")[0].split(":")[0]
        except IndexError:
            dom = portal.split("/")[0].split(":")[0]
        self.s.cookies.clear()
        self.s.cookies.set("mac", mac, domain=dom)
        self.s.cookies.set("stb_lang", "en", domain=dom)
        self.s.cookies.set("timezone", "America/New_York", domain=dom)

    @property
    def api(self):
        return f"{self.cfg['portal_url']}/server/load.php"

    def _call(self, params):
        params["JsHttpRequest"] = "1-xml"
        if self.token:
            self.s.headers["Authorization"] = f"Bearer {self.token}"
        r = self.s.get(self.api, params=params, timeout=15)
        r.raise_for_status()
        return r.json().get("js", r.json())

    def auth(self):
        self._setup()
        pre = hashlib.sha1(os.urandom(20)).hexdigest()
        res = self._call({"type": "stb", "action": "handshake", "token": "", "prehash": pre})
        self.token = res["token"]
        rnd = hashlib.sha1(os.urandom(20)).hexdigest()
        mac = self.cfg.get("mac", "")
        sn = self.cfg.get("serial", "")
        dev = self.cfg.get("device", "AuraHD9")
        metrics = json.dumps({"mac": mac, "sn": sn, "model": dev, "type": "STB", "uid": "", "random": rnd})
        ver = (
            "ImageDescription: 0.2.16-234; ImageDate: Fri Jan 15 15:20:44 EET 2016; "
            "PORTAL version: 5.6.10; API Version: JS API version: 328; "
            "STB API version: 134; Player Engine version: 0x566"
        )
        return self._call({
            "type": "stb", "action": "get_profile", "hd": "1", "ver": ver,
            "num_banks": "2", "sn": sn, "stb_type": dev, "client_type": "STB",
            "image_version": self.cfg.get("image_version", "216"), "video_out": "hdmi",
            "device_id": "", "device_id2": "", "signature": "", "auth_second_step": "1",
            "hw_version": self.cfg.get("hw_version", "1.7-BD-00"), "not_valid_token": "0",
            "metrics": metrics, "hw_version_2": hashlib.sha1(mac.encode()).hexdigest(),
            "timestamp": str(int(time.time())),
            "api_signature": self.cfg.get("api_signature", "262"),
            "prehash": hashlib.sha1(os.urandom(20)).hexdigest(),
        })

    def categories(self):
        return self._call({"type": "vod", "action": "get_categories"})

    def vod_list(self, cat="*", page=1, search=None):
        p = {"type": "vod", "action": "get_ordered_list", "movie_id": "0",
             "season_id": "0", "episode_id": "0", "category": str(cat),
             "fav": "0", "sortby": "added", "hd": "0", "not_ended": "0", "p": str(page)}
        if search:
            p["search"] = search
        return self._call(p)

    def movie_files(self, mid):
        return self._call({"type": "vod", "action": "get_ordered_list", "movie_id": str(mid),
                           "season_id": "0", "episode_id": "0", "category": "*",
                           "fav": "0", "sortby": "added", "hd": "0", "not_ended": "0", "p": "1"})

    def seasons(self, mid):
        return self._call({"type": "vod", "action": "get_ordered_list", "movie_id": str(mid),
                           "season_id": "0", "episode_id": "0", "category": "*",
                           "fav": "0", "sortby": "added", "hd": "0", "not_ended": "0", "p": "1"})

    def episodes(self, mid, season_id):
        return self._call({"type": "vod", "action": "get_ordered_list", "movie_id": str(mid),
                           "season_id": str(season_id), "episode_id": "0", "category": "*",
                           "fav": "0", "sortby": "added", "hd": "0", "not_ended": "0", "p": "1"})

    def episode_files(self, mid, season_id, episode_id):
        return self._call({"type": "vod", "action": "get_ordered_list", "movie_id": str(mid),
                           "season_id": str(season_id), "episode_id": str(episode_id), "category": "*",
                           "fav": "0", "sortby": "added", "hd": "0", "not_ended": "0", "p": "1"})

    def create_link(self, fid):
        r = self._call({"type": "vod", "action": "create_link", "cmd": f"/media/file_{fid}.mpg",
                        "series": "", "forced_storage": "", "disable_ad": "0",
                        "download": "0", "force_ch_link_check": "0"})
        return r.get("cmd", "")

    def tv_genres(self):
        return self._call({"type": "itv", "action": "get_genres"})

    def tv_channels(self, genre="*", page=1):
        return self._call({"type": "itv", "action": "get_ordered_list", "genre": str(genre),
                           "fav": "0", "sortby": "number", "p": str(page), "force_ch_link_check": ""})

    def tv_link(self, cmd):
        r = self._call({"type": "itv", "action": "create_link", "cmd": cmd,
                        "series": "", "forced_storage": "", "disable_ad": "0", "force_ch_link_check": "0"})
        return r.get("cmd", "")
