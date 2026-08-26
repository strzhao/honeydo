"""gen.py - 文生图驱动（diffusers bf16 + LoRA 叠加 + 可选超分）。
 * 入参：argv[1] = JSON {prompt, out, snapshot, width, height, steps, trueCfg, neg, num, seed,
 *                        loras: [{path, scale}], upscaleTo?: [w,h], esrganModel?}
 *   trueCfg: true CFG 强度（官方推荐 4.0；<=1 无引导——旧版行为；蒸馏 LoRA 路径用 1.0）
 *   neg: 负向提示词（trueCfg>1 时才下发；官方 2512 中文负向模板由 CLI 层注入）
 *   num: 一次生成张数（1-4），输出 out-1.png..out-N.png
 * 出参：stdout 最后一行 JSON {out, seconds, upscaled?, outs?}（num=1 形状与旧版一致）
 * 历史坑：guidance_scale 参数被 diffusers 静默忽略（仅 guidance-distilled 模型生效），
 *         真实旋钮是 true_cfg_scale，且必须传 negative_prompt 才启用——2026-08 修复。
 """
import json
import os
import sys
import time

import torch
from diffusers import QwenImagePipeline
from PIL import Image


def main() -> None:
    cfg = json.loads(sys.argv[1])
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    pipe = QwenImagePipeline.from_pretrained(cfg["snapshot"], torch_dtype=torch.bfloat16)
    loras = cfg.get("loras") or []
    if loras:
        names = []
        for i, l in enumerate(loras):
            name = f"l{i}"
            pipe.load_lora_weights(l["path"], adapter_name=name)
            names.append(name)
        pipe.set_adapters(names, adapter_weights=[l.get("scale", 1.0) for l in loras])
    pipe = pipe.to("mps")

    t0 = time.time()
    true_cfg = float(cfg.get("trueCfg", 1.0))
    neg = cfg.get("neg") if true_cfg > 1.0 else None  # 无引导路径不传负向，避免 diffusers 警告
    num = int(cfg.get("num", 1))
    images = pipe(
        prompt=cfg["prompt"],
        negative_prompt=neg,
        true_cfg_scale=true_cfg,
        width=cfg.get("width", 1664),
        height=cfg.get("height", 928),
        num_inference_steps=cfg.get("steps", 20),
        num_images_per_prompt=num,
        generator=torch.Generator(device="mps").manual_seed(cfg.get("seed", 42)),
    ).images

    up = cfg.get("upscaleTo")
    sr = None
    if up:
        from spandrel import ModelLoader
        import numpy as np

        sr = ModelLoader().load_from_file(
            cfg.get("esrganModel") or "/tmp/RealESRGAN_x2.pth"
        ).to("mps").eval()

    outs = []
    for i, im in enumerate(images, start=1):
        if up:
            arr = np.array(im.convert("RGB")).astype(np.float32) / 255.0
            t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to("mps")
            with torch.no_grad():
                out_t = sr(t)
            im = Image.fromarray(
                (out_t.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype("uint8")
            ).resize((up[0], up[1]), Image.LANCZOS)
        if num == 1:
            p = cfg["out"]
        else:
            root, ext = os.path.splitext(cfg["out"])
            p = f"{root}-{i}{ext or '.png'}"
        im.save(p)
        outs.append(p)

    result = {"out": outs[0], "seconds": round(time.time() - t0, 1)}
    if num > 1:
        result["outs"] = outs
    if up:
        result["upscaled"] = up

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
