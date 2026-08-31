"""edit.py - 参考图编辑驱动（QwenImageEditPlusPipeline，1+ 张参考图）。
 * 直跑：argv[1] = JSON {prompt, out, snapshotEdit, refs: [path...], width, height, steps, trueCfg, neg, seed,
 *                        loras?: [{path, scale}], lightningSched?: bool, teaCache?: {thresh}|true}
 * serve.py 复用：load_pipe / run（daemon 常驻热路径）
 *   trueCfg: true CFG 强度（官方 Edit-2511 配方 4.0；<=1 无引导——旧版行为/蒸馏 LoRA 路径）
 *   neg: 负向提示词（官方编辑配方默认 " "，trueCfg>1 时才下发）
 *   loras: LoRA 叠加（如 lightningedit2511 蒸馏加速，scale 固定 1.0）
 *   lightningSched: Lightning 蒸馏专用调度器（base_shift=max_shift=ln3、shift_terminal=None；
 *                   蒸馏分布外 shift 区间 0.5-0.9 会掉质——官方 generate_with_diffusers.py 同款配置）
 *   teaCache: TeaCache 步缓存（teacache.py；质量近似无损加速， thresh 缺省 0.2）
 * 出参：stdout 最后一行 JSON {out, seconds, teaCache?}
 * 历史坑：guidance_scale 被 diffusers 静默忽略，真实旋钮 true_cfg_scale+negative_prompt——2026-08 修复。
"""
import json
import math
import os
import sys
import time

import torch
from diffusers import FlowMatchEulerDiscreteScheduler, QwenImageEditPlusPipeline
from PIL import Image

# Lightning 蒸馏 LoRA 调度器（与 gen.py 同名定义逐字段一致；改参数两处需同步——serve.py 用 gen 的）
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


def load_pipe(
    snapshot_edit: str, loras: list | None = None, lightning_sched: bool = False
) -> QwenImageEditPlusPipeline:
    """from_pretrained(bf16) → LoRA（CPU 上，须在 to("mps") 前）→ 可选蒸馏调度器 → to("mps")。"""
    pipe = QwenImageEditPlusPipeline.from_pretrained(snapshot_edit, torch_dtype=torch.bfloat16)
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


def run(pipe: QwenImageEditPlusPipeline, cfg: dict) -> dict:
    """一次编辑并落盘，返回结果 dict（不 print）。
    refVaeSize: 实验开关——monkeypatch 管线 VAE_IMAGE_SIZE（官方 1024² 面积），
    参考图 token 占序列 ~64%（4ref@2048），降面积是出版档候选加速；任务后恢复原值（daemon 安全）。"""
    from teacache import apply_teacache

    tc = apply_teacache(pipe, cfg)
    t0 = time.time()
    true_cfg = float(cfg.get("trueCfg", 1.0))
    neg = cfg.get("neg") if true_cfg > 1.0 else None
    refs = [Image.open(p).convert("RGB") for p in cfg["refs"]]

    import diffusers.pipelines.qwenimage.pipeline_qwenimage_edit_plus as plus_mod

    old_vae_size = plus_mod.VAE_IMAGE_SIZE
    if cfg.get("refVaeSize"):
        plus_mod.VAE_IMAGE_SIZE = int(cfg["refVaeSize"])
    try:
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
    finally:
        plus_mod.VAE_IMAGE_SIZE = old_vae_size
    img.save(cfg["out"])
    result = {"out": cfg["out"], "seconds": round(time.time() - t0, 1)}
    if tc is not None:
        result["teaCache"] = tc.stats()
    if cfg.get("refVaeSize"):
        result["refVaeSize"] = int(cfg["refVaeSize"])
    return result


def main() -> None:
    cfg = json.loads(sys.argv[1])
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    pipe = load_pipe(cfg["snapshotEdit"], cfg.get("loras"), bool(cfg.get("lightningSched")))
    print(json.dumps(run(pipe, cfg), ensure_ascii=False))


if __name__ == "__main__":
    main()
