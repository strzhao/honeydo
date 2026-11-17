#!/usr/bin/env python3
"""lmedia h3 阶段一：文本塔编码（MiniMax-H3-Image，Mac 统一内存两段式约束：文本塔与 DiT 不同驻）

协议（对齐 src/lib/run-python.ts）：argv[1] = 单行 JSON payload；stdout 末行 = 单行 compact JSON 结果；
进度/阶段标记一律 stderr（[h3:encode] 前缀）。退出码 0 成功 / 1 运行错误。

payload: {runtime, work, mock?, prompt_refs: [{prompt, images: [路径], seed?}]}
产出: 逐条 work/<i>.pt（prompt + refs + seed + prompt_embeds + text_token_tags + [reference_latents]）+ work/<i>.encode.json

mock 模式（payload mock:true，LMEDIA_IMAGE_MOCK=1 测试 seam）：跳过模型加载，仅用标准库落盘
（.pt 为 JSON 描述文件，结构与真实产物 meta 对齐），全流程秒级。
真实逻辑移植自外盘已验证的 h3img.py（encode 段）：MiniMaxH3ImagePipeline ModularPipeline 载
text_encoder/tokenizer/processor（编辑模式加 vae）→ before_encode/text_encoder(/vae_encoder) →
embedding 落盘 → 全部条目跑完进程退出释放内存。
"""
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def emit(obj) -> None:
    """结果行必须是单行 compact JSON（内部禁换行；TS 取 stdout 末行解析）"""
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), flush=True)


def resolve_dirs(runtime: str):
    """栈根两种布局（迁移期均识别）：weights/image+weights/tower 新布局；image+tower 同层 legacy"""
    rt = Path(runtime)
    image_dir = rt / "weights" / "image"
    if not (image_dir / "transformer_diffusers").exists():
        image_dir = rt / "image"
    tower_dir = rt / "weights" / "tower"
    if not (tower_dir / "text_encoder").exists():
        tower_dir = rt / "tower"
    return image_dir, tower_dir


# ———————————————————————————— mock 模式（裸标准库，无第三方依赖） ————————————————————————————

def mock_encode_one(i: int, item: dict, work: Path) -> dict:
    t0 = time.time()
    prompt = item["prompt"]
    images = item.get("images") or []
    time.sleep(0.05)  # 模拟编码耗时（可观测时序）
    log(f"[h3:encode] {now()} item {i} mock encode chars={len(prompt)} refs={len(images)}")
    pt_path = work / f"{i}.pt"
    # 真实模式此处是 torch.save(张量载荷)；mock 无 torch，落 JSON 描述（生成阶段只校验存在性）
    pt_path.write_text(json.dumps({
        "mock": True,
        "prompt": prompt,
        "refs": images,
        "embeds_shape": [1, 8, 4096],
    }, ensure_ascii=False), encoding="utf-8")
    meta = {
        "index": i,
        "pt": str(pt_path),
        "prompt_chars": len(prompt),
        "refs": images,
        "embeds_shape": [1, 8, 4096],
        "elapsed_s": round(time.time() - t0, 2),
    }
    (work / f"{i}.encode.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


# ———————————————————————————— 真实模式（移植 h3img.py encode 段） ————————————————————————————

def pick_auto(block, conditioned: bool):
    """Auto 块按 image 有无选 text2image / image_conditioned 子块；无对应子块 = 条件不满足 = 跳过"""
    subs = getattr(block, "sub_blocks", None)
    if not subs:
        return block
    key = "image_conditioned" if conditioned else "text2image"
    return subs.get(key)


def run_block(pipe, state, name: str, conditioned: bool):
    block = pick_auto(pipe._blocks.sub_blocks[name], conditioned)
    if block is None:
        log(f"[h3:encode] {now()}   {name}: skipped")
        return state
    t0 = time.time()
    _, state = block(pipe, state)
    log(f"[h3:encode] {now()}   {name}: done {time.time() - t0:.1f}s")
    return state


def load_text_tower(image_dir: Path, tower_dir: Path, any_edit: bool):
    import gc

    import torch
    from diffusers import ModularPipeline

    pipe = ModularPipeline.from_pretrained(str(image_dir), local_files_only=True)
    names = ["text_encoder", "tokenizer", "processor"] + (["vae"] if any_edit else [])
    t0 = time.time()
    log(f"[h3:encode] {now()} loading {names} ...")
    pipe.load_components(
        names=names,
        dtype={"text_encoder": torch.bfloat16, "default": torch.float32},
        pretrained_model_name_or_path={"text_encoder": str(tower_dir), "default": str(image_dir)},
    )
    log(f"[h3:encode] {now()} components loaded {time.time() - t0:.0f}s; moving to mps")
    missing = [n for n in names if getattr(pipe, n, None) is None]
    if missing:
        raise RuntimeError(f"components failed to load: {missing}")
    pipe.text_encoder.to("mps")
    if any_edit:
        pipe.vae.to("mps")
    gc.collect()
    alloc = torch.mps.current_allocated_memory() / 1e9
    log(f"[h3:encode] {now()} text encoder on mps, alloc {alloc:.1f}GB")
    return pipe


def real_encode_one(i: int, item: dict, work: Path, pipe) -> dict:
    from diffusers.modular_pipelines.modular_pipeline import PipelineState

    import torch
    from PIL import Image

    t0 = time.time()
    prompt = item["prompt"]
    images = [Image.open(p).convert("RGB") for p in (item.get("images") or [])]
    conditioned = bool(images)
    log(f"[h3:encode] {now()} item {i} encode (edit={conditioned}) chars={len(prompt)}")
    state = PipelineState()
    state.set("prompt", prompt)
    if images:
        state.set("image", images if len(images) > 1 else images[0])
    seed = int(item.get("seed", 42))
    state.set("generator", torch.Generator(device="cpu").manual_seed(seed))
    state = run_block(pipe, state, "before_encode", conditioned=conditioned)
    state = run_block(pipe, state, "text_encoder", conditioned=conditioned)
    if images:
        state = run_block(pipe, state, "vae_encoder", conditioned=True)

    embeds = state.get("prompt_embeds").cpu()
    # refs 必须进入张量载荷：阶段二靠它恢复参考图并选择 image_conditioned；
    # 只写 encode meta 会让阶段二静默退回 text2image（此前所有风格 A/B 因此失效）。
    payload = {
        "prompt": prompt,
        "refs": list(item.get("images") or []),
        "seed": seed,
        "prompt_embeds": embeds,
        "text_token_tags": state.get("text_token_tags").cpu(),
    }
    if images:
        payload["reference_latents"] = [t.cpu() for t in state.get("reference_latents")]
    pt_path = work / f"{i}.pt"
    torch.save(payload, pt_path)
    meta = {
        "index": i,
        "pt": str(pt_path),
        "prompt_chars": len(prompt),
        "refs": list(item.get("images") or []),
        "embeds_shape": list(embeds.shape),
        "elapsed_s": round(time.time() - t0, 1),
    }
    (work / f"{i}.encode.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"[h3:encode] {now()} item {i} saved ({time.time() - t0:.1f}s, embeds {tuple(embeds.shape)})")
    return meta


def main() -> None:
    payload = json.loads(sys.argv[1])
    mock = bool(payload.get("mock"))
    work = Path(payload["work"])
    work.mkdir(parents=True, exist_ok=True)
    image_dir, tower_dir = resolve_dirs(payload["runtime"])
    items = payload["prompt_refs"]

    pipe = None
    if mock:
        log(f"[h3:encode] {now()} mock mode: skip model load ({len(items)} items)")
    else:
        any_edit = any(item.get("images") for item in items)
        pipe = load_text_tower(image_dir, tower_dir, any_edit)

    results = []
    failed = 0
    for i, item in enumerate(items):
        try:
            if mock:
                results.append(mock_encode_one(i, item, work))
            else:
                results.append(real_encode_one(i, item, work, pipe))
        except Exception as e:  # 逐条隔离：单条失败不中断其余（batch 审计契约）
            failed += 1
            results.append({"index": i, "failed": True, "error": f"{type(e).__name__}: {e}"})
            log(f"[h3:encode] {now()} item {i} FAILED: {e}")
            traceback.print_exc(file=sys.stderr)

    emit({"items": results, "failed": failed})
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        log(f"[h3:encode] {now()} fatal: {type(e).__name__}: {e}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
