"""gen.py - 文生图驱动（diffusers bf16 + LoRA 叠加 + 可选超分）。
 * 直跑：argv[1] = JSON {prompt, out, snapshot, width, height, steps, trueCfg, neg, num, seed,
 *                        loras: [{path, scale}], lightningSched?: bool, teaCache?: {thresh}|true,
 *                        upscaleTo?: [w,h], esrganModel?}
 * serve.py 复用：load_pipe / load_esrgan / run（daemon 常驻热路径，免每次 ~2min 冷加载）
 *   trueCfg: true CFG 强度（官方推荐 4.0；<=1 无引导——旧版行为；蒸馏 LoRA 路径用 1.0）
 *   neg: 负向提示词（trueCfg>1 时才下发；官方 2512 中文负向模板由 CLI 层注入）
 *   num: 一次生成张数（1-4），输出 out-1.png..out-N.png
 *   lightningSched: Lightning 蒸馏专用调度器（base_shift=max_shift=ln3、shift_terminal=None；
 *                   用默认调度器跑蒸馏 LoRA 是分布外，会掉质——2026-08-29 修复 --fast 遗漏）
 *   teaCache: TeaCache 步缓存（teacache.py；质量近似无损加速，thresh 缺省 0.2）
 * 出参：stdout 最后一行 JSON {out, seconds, upscaled?, outs?, teaCache?}（num=1 形状与旧版一致）
 * 历史坑：guidance_scale 参数被 diffusers 静默忽略（仅 guidance-distilled 模型生效），
 *         真实旋钮是 true_cfg_scale，且必须传 negative_prompt 才启用——2026-08 修复。
 """
import json
import math
import os
import sys
import time

import torch
from diffusers import FlowMatchEulerDiscreteScheduler, QwenImagePipeline
from PIL import Image

# Lightning 蒸馏 LoRA 调度器（shift=3 蒸馏分布；官方 generate_with_diffusers.py 同款）
LIGHTNING_SCHEDULER_CONFIG = {
    "base_image_seq_len": 256,
    "base_shift": math.log(3),
    "invert_sigmas": False,
    "max_image_seq_len": 8192,
    "max_shift": math.log(3),
    "num_train_timesteps": 1000,
    "shift": 1.0,
    "shift_terminal": None,
    "stochastic_sampling": False,
    "time_shift_type": "exponential",
    "use_beta_sigmas": False,
    "use_dynamic_shifting": True,
    "use_exponential_sigmas": False,
    "use_karras_sigmas": False,
}


def load_pipe(snapshot: str, loras: list | None = None, lightning_sched: bool = False) -> QwenImagePipeline:
    """from_pretrained(bf16) → LoRA（CPU 上加载，须在 to("mps") 前）→ 可选蒸馏调度器 → to("mps")。"""
    pipe = QwenImagePipeline.from_pretrained(snapshot, torch_dtype=torch.bfloat16)
    if loras:
        names = []
        for i, l in enumerate(loras):
            name = f"l{i}"
            pipe.load_lora_weights(l["path"], adapter_name=name)
            names.append(name)
        pipe.set_adapters(names, adapter_weights=[l.get("scale", 1.0) for l in loras])
    if lightning_sched:
        pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(LIGHTNING_SCHEDULER_CONFIG)
    return pipe.to("mps")


def load_esrgan(path: str | None = None):
    """Real-ESRGAN x2（spandrel，MPS）——懒加载，权重缺文件时抛错（doctor 有检查项）。"""
    from spandrel import ModelLoader

    return ModelLoader().load_from_file(path or "/tmp/RealESRGAN_x2.pth").to("mps").eval()


def run(pipe: QwenImagePipeline, cfg: dict, sr=None) -> dict:
    """一次生成并落盘，返回结果 dict（不 print——print 由调用方/直跑 main 做）。
    sr: 预载 ESRGAN 模型（daemon 复用）；upscaleTo 存在且 sr=None 时现场加载。"""
    from teacache import apply_teacache

    tc = apply_teacache(pipe, cfg)
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
    if up and sr is None:
        sr = load_esrgan(cfg.get("esrganModel"))
    if up:
        import numpy as np

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
    if tc is not None:
        result["teaCache"] = tc.stats()
    return result


def main() -> None:
    cfg = json.loads(sys.argv[1])
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    pipe = load_pipe(cfg["snapshot"], cfg.get("loras"), bool(cfg.get("lightningSched")))
    print(json.dumps(run(pipe, cfg), ensure_ascii=False))


if __name__ == "__main__":
    main()
