"""edit.py - 参考图编辑驱动（QwenImageEditPlusPipeline，1+ 张参考图）。
 * 入参：argv[1] = JSON {prompt, out, snapshotEdit, refs: [path...], width, height, steps, guidance, seed}
 * 出参：stdout 最后一行 JSON {out, seconds}
"""
import json
import os
import sys
import time

import torch
from diffusers import QwenImageEditPlusPipeline
from PIL import Image


def main() -> None:
    cfg = json.loads(sys.argv[1])
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    pipe = QwenImageEditPlusPipeline.from_pretrained(cfg["snapshotEdit"], torch_dtype=torch.bfloat16)
    pipe = pipe.to("mps")
    refs = [Image.open(p).convert("RGB") for p in cfg["refs"]]

    t0 = time.time()
    img = pipe(
        image=refs,
        prompt=cfg["prompt"],
        width=cfg.get("width", 1664),
        height=cfg.get("height", 928),
        num_inference_steps=cfg.get("steps", 20),
        guidance_scale=cfg.get("guidance", 4.0),
        generator=torch.Generator(device="mps").manual_seed(cfg.get("seed", 42)),
    ).images[0]
    img.save(cfg["out"])
    print(json.dumps({"out": cfg["out"], "seconds": round(time.time() - t0, 1)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
