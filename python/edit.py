"""edit.py - 参考图编辑驱动（QwenImageEditPlusPipeline，1+ 张参考图）。
 * 入参：argv[1] = JSON {prompt, out, snapshotEdit, refs: [path...], width, height, steps, trueCfg, neg, seed}
 *   trueCfg: true CFG 强度（官方 Edit-2511 配方 4.0；<=1 无引导——旧版行为）
 *   neg: 负向提示词（官方编辑配方默认 " "，trueCfg>1 时才下发）
 * 出参：stdout 最后一行 JSON {out, seconds}
 * 历史坑：guidance_scale 被 diffusers 静默忽略，真实旋钮 true_cfg_scale+negative_prompt——2026-08 修复。
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
    true_cfg = float(cfg.get("trueCfg", 1.0))
    neg = cfg.get("neg") if true_cfg > 1.0 else None
    img = pipe(
        image=refs,
        prompt=cfg["prompt"],
        negative_prompt=neg,
        true_cfg_scale=true_cfg,
        width=cfg.get("width", 1664),
        height=cfg.get("height", 928),
        num_inference_steps=cfg.get("steps", 20),
        generator=torch.Generator(device="mps").manual_seed(cfg.get("seed", 42)),
    ).images[0]
    img.save(cfg["out"])
    print(json.dumps({"out": cfg["out"], "seconds": round(time.time() - t0, 1)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
