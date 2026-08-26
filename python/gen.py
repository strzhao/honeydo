"""gen.py - 文生图驱动（diffusers bf16 + LoRA 叠加 + 可选超分）。
 * 入参：argv[1] = JSON {prompt, out, snapshot, width, height, steps, guidance, seed,
 *                        loras: [{path, scale}], upscaleTo?: [w,h], esrganModel?}
 * 出参：stdout 最后一行 JSON {out, seconds, upscaled?}
"""
import json
import os
import sys
import time

import torch
from diffusers import QwenImagePipeline


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
    img = pipe(
        prompt=cfg["prompt"],
        width=cfg.get("width", 1664),
        height=cfg.get("height", 928),
        num_inference_steps=cfg.get("steps", 20),
        guidance_scale=cfg.get("guidance", 4.0),
        generator=torch.Generator(device="mps").manual_seed(cfg.get("seed", 42)),
    ).images[0]
    img.save(cfg["out"])
    result = {"out": cfg["out"], "seconds": round(time.time() - t0, 1)}

    up = cfg.get("upscaleTo")
    if up:
        from spandrel import ModelLoader
        import numpy as np
        from PIL import Image

        model = ModelLoader().load_from_file(
            cfg.get("esrganModel") or "/tmp/RealESRGAN_x2.pth"
        ).to("mps").eval()
        arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
        t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to("mps")
        with torch.no_grad():
            out_t = model(t)
        up_img = Image.fromarray(
            (out_t.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype("uint8")
        ).resize((up[0], up[1]), Image.LANCZOS)
        up_img.save(cfg["out"])
        result["upscaled"] = up

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
