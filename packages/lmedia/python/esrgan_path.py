"""Real-ESRGAN 权重路径解析：env LMEDIA_REALESRGAN_PATH > ~/.cache/lmedia/ > 历史 /tmp 位"""
import os

CACHE_PATH = os.path.expanduser("~/.cache/lmedia/RealESRGAN_x2.pth")
LEGACY_TMP_PATH = "/tmp/RealESRGAN_x2.pth"


def resolve_esrgan_path() -> str:
    env = os.environ.get("LMEDIA_REALESRGAN_PATH")
    if env and os.path.exists(env):
        return env
    if os.path.exists(CACHE_PATH):
        return CACHE_PATH
    if os.path.exists(LEGACY_TMP_PATH):
        return LEGACY_TMP_PATH
    return env or CACHE_PATH
