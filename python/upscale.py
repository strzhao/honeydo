"""upscale.py - Real-ESRGAN x2 超分（spandrel + MPS）。
 * 入参：argv[1] = JSON {in, out, finalSize?: [w,h], model?}
"""
import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image
from spandrel import ModelLoader

cfg = json.loads(sys.argv[1])
t0 = time.time()
device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ModelLoader().load_from_file(cfg.get("model") or "/tmp/RealESRGAN_x2.pth").to(device).eval()
img = np.array(Image.open(cfg["in"]).convert("RGB")).astype(np.float32) / 255.0
t = torch.from_numpy(img).permute(2, 0, 1).unsqueeze(0).to(device)
with torch.no_grad():
    out = model(t)
up = Image.fromarray((out.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype("uint8"))
if cfg.get("finalSize"):
    up = up.resize(tuple(cfg["finalSize"]), Image.LANCZOS)
up.save(cfg["out"])
print(json.dumps({"out": cfg["out"], "size": up.size, "seconds": round(time.time() - t0, 1)}))
