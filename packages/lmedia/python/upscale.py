"""upscale.py - Real-ESRGAN x2 超分（spandrel + MPS）。
 * 直跑：argv[1] = JSON {in, out, finalSize?: [w,h], model?}
 * serve.py 复用：load_model / run（daemon 内懒加载常驻，二次超分秒级）
"""
import json
import sys
import time

import numpy as np
import torch
from PIL import Image
from spandrel import ModelLoader


def load_model(path: str | None = None):
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    return ModelLoader().load_from_file(path or "/tmp/RealESRGAN_x2.pth").to(device).eval()


def run(model, cfg: dict) -> dict:
    t0 = time.time()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    img = np.array(Image.open(cfg["in"]).convert("RGB")).astype(np.float32) / 255.0
    t = torch.from_numpy(img).permute(2, 0, 1).unsqueeze(0).to(device)
    with torch.no_grad():
        out = model(t)
    up = Image.fromarray((out.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype("uint8"))
    if cfg.get("finalSize"):
        up = up.resize(tuple(cfg["finalSize"]), Image.LANCZOS)
    up.save(cfg["out"])
    return {"out": cfg["out"], "size": up.size, "seconds": round(time.time() - t0, 1)}


def main() -> None:
    cfg = json.loads(sys.argv[1])
    print(json.dumps(run(load_model(cfg.get("model")), cfg), ensure_ascii=False))


if __name__ == "__main__":
    main()
