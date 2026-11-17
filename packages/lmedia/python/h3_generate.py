#!/usr/bin/env python3
"""lmedia h3 阶段二：DiT 采样 + VAE 解码（+ publish 档 LANCZOS 降采样）

协议（对齐 src/lib/run-python.ts）：argv[1] = 单行 JSON payload；stdout 末行 = 单行 compact JSON 结果；
进度/阶段标记一律 stderr（[h3:denoise] 前缀）。退出码 0 成功 / 1 运行错误（条目级失败逐条审计不中断）。

payload: {runtime, work, mock?, items: [{index, seed, size, quality, out}]}
  size = 生成档分辨率 "WxH"（draft 2048x1152 直出；publish 5472x3072 生成后 LANCZOS 缩回 2736x1536）
产出: 逐条 PNG（先写临时文件再 rename——无半成品残留）+ resolution 回显（最终名义尺寸）

mock 模式（payload mock:true，LMEDIA_IMAGE_MOCK=1 测试 seam）：跳过模型加载，仅校验 encode.pt 在位，
用标准库（zlib+struct）手写最小合法 PNG（裸桩 venv 无第三方包），尺寸 = 该 quality 档最终名义尺寸
（draft 2048x1152 / publish 缩回后 2736x1536），全流程秒级且输出契约与真实模式一致。
真实逻辑移植自外盘已验证的 h3img.py（generate 段）。
"""
import json
import os
import struct
import sys
import time
import traceback
import zlib
from datetime import datetime
from pathlib import Path

# quality 档 → (生成尺寸, 最终名义尺寸)；publish 生成 2x 后 LANCZOS 缩回
QUALITY_SIZES = {
    "draft": ((2048, 1152), (2048, 1152)),
    "publish": ((5472, 3072), (2736, 1536)),
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def emit(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), flush=True)


def resolve_dirs(runtime: str):
    """与 h3_encode.py 同源：weights/ 新布局优先，image/tower 同层 legacy 回退"""
    rt = Path(runtime)
    image_dir = rt / "weights" / "image"
    if not (image_dir / "transformer_diffusers").exists():
        image_dir = rt / "image"
    tower_dir = rt / "weights" / "tower"
    if not (tower_dir / "text_encoder").exists():
        tower_dir = rt / "tower"
    return image_dir, tower_dir


def parse_size(size: str):
    w, h = (int(x) for x in str(size).lower().split("x"))
    return w, h


def atomic_save_png(img, out: str) -> None:
    """先写临时文件再 rename——输出路径不残留半成品。

    临时文件后缀不可推断格式（.tmp<pid>），必须显式 format='PNG'，
    否则 PIL 按扩展名猜格式会抛 `unknown file extension`。"""
    tmp = f"{out}.tmp{os.getpid()}"
    img.save(tmp, format="PNG")
    os.replace(tmp, out)


# ———————————————————————————— mock 模式（裸标准库手写最小合法 PNG） ————————————————————————————

def write_png(path: str, width: int, height: int) -> None:
    """8-bit RGB 纯色最小合法 PNG（zlib+struct，不依赖 Pillow）"""
    raw = (b"\x00" + b"\x8a\xb6\xd8" * width) * height  # 每行 filter byte 0 + RGB 像素

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, path)


def mock_generate_one(item: dict, work: Path) -> dict:
    t0 = time.time()
    i = int(item["index"])
    pt_path = work / f"{i}.pt"
    if not pt_path.exists():
        raise RuntimeError(f"encode 产物缺失: {pt_path}（阶段一未跑或被清理）")
    quality = item.get("quality", "draft")
    if quality not in QUALITY_SIZES:
        raise RuntimeError(f"未知 quality 档: {quality}（draft|publish）")
    _gen_size, final_size = QUALITY_SIZES[quality]
    time.sleep(0.05)  # 模拟去噪耗时（可观测时序）
    log(f"[h3:denoise] {now()} item {i} mock denoise/decode "
        f"({final_size[0]}x{final_size[1]} {quality})")
    out = item["out"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    write_png(out, final_size[0], final_size[1])
    return {
        "index": i,
        "out": out,
        "resolution": f"{final_size[0]}x{final_size[1]}",
        "elapsed_s": round(time.time() - t0, 2),
    }


# ———————————————————————————— 真实模式（移植 h3img.py generate 段） ————————————————————————————

def load_dit(image_dir: Path):
    import gc

    import torch
    from diffusers import ComponentsManager, ModularPipeline

    manager = ComponentsManager()
    pipe = ModularPipeline.from_pretrained(str(image_dir), components_manager=manager,
                                           local_files_only=True)
    names = ["transformer", "vae", "scheduler"]
    t0 = time.time()
    log(f"[h3:denoise] {now()} loading transformer+vae+scheduler ...")
    pipe.load_components(
        names=names,
        dtype={"transformer": torch.bfloat16, "default": torch.float32},
        pretrained_model_name_or_path={"default": str(image_dir)},
    )
    log(f"[h3:denoise] {now()} components loaded {time.time() - t0:.0f}s; moving to mps")
    missing = [n for n in names if getattr(pipe, n, None) is None]
    if missing:
        raise RuntimeError(f"components failed to load: {missing}")
    # hook 负责在组件调用时搬运输入（权重已在位，模块搬运为 no-op）
    manager.enable_auto_cpu_offload(device="mps")
    pipe.transformer.to("mps")
    pipe.vae.to("mps")
    gc.collect()
    alloc = torch.mps.current_allocated_memory() / 1e9
    log(f"[h3:denoise] {now()} transformer on mps, alloc {alloc:.1f}GB")
    return pipe


def pick_auto(block, conditioned: bool):
    subs = getattr(block, "sub_blocks", None)
    if not subs:
        return block
    key = "image_conditioned" if conditioned else "text2image"
    return subs.get(key)


def run_block(pipe, state, name: str, conditioned: bool):
    block = pick_auto(pipe._blocks.sub_blocks[name], conditioned)
    if block is None:
        log(f"[h3:denoise] {now()}   {name}: skipped")
        return state
    t0 = time.time()
    _, state = block(pipe, state)
    log(f"[h3:denoise] {now()}   {name}: done {time.time() - t0:.1f}s")
    return state


def real_generate_one(item: dict, work: Path, pipe) -> dict:
    from diffusers.modular_pipelines.modular_pipeline import PipelineState

    import torch
    from PIL import Image

    t0 = time.time()
    i = int(item["index"])
    quality = item.get("quality", "draft")
    if quality not in QUALITY_SIZES:
        raise RuntimeError(f"未知 quality 档: {quality}（draft|publish）")
    gen_size, final_size = QUALITY_SIZES[quality]
    if item.get("size"):
        gen_size = parse_size(item["size"])
    width, height = gen_size

    payload = torch.load(work / f"{i}.pt", weights_only=False)
    refs = list(payload.get("refs") or [])
    if bool(refs) != ("reference_latents" in payload):
        raise RuntimeError("encode 产物参考图状态不一致：refs 与 reference_latents 必须同时存在")
    images = [Image.open(p).convert("RGB") for p in refs]
    conditioned = bool(images)
    log(f"[h3:denoise] {now()} item {i} generate {width}x{height} edit={conditioned} ({quality})")

    state = PipelineState()
    if conditioned:
        state.set("image", images if len(images) > 1 else images[0])
        state.set("reference_latents", payload["reference_latents"])
    state.set("prompt_embeds", payload["prompt_embeds"])
    state.set("text_token_tags", payload["text_token_tags"])
    seed = int(item.get("seed", payload.get("seed", 42)))
    state.set("generator", torch.Generator(device="cpu").manual_seed(seed))
    state.set("height", height)
    state.set("width", width)
    state = run_block(pipe, state, "before_encode", conditioned=conditioned)
    state = run_block(pipe, state, "denoise", conditioned=conditioned)
    state = run_block(pipe, state, "decode", conditioned=conditioned)

    img = state.get("images")[0]
    if quality == "publish":
        img = img.resize(final_size, Image.LANCZOS)
    out = item["out"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    atomic_save_png(img, out)
    log(f"[h3:denoise] {now()} item {i} saved {out} ({time.time() - t0:.1f}s)")
    return {
        "index": i,
        "out": out,
        "resolution": f"{final_size[0]}x{final_size[1]}",
        "elapsed_s": round(time.time() - t0, 1),
    }


def main() -> None:
    payload = json.loads(sys.argv[1])
    mock = bool(payload.get("mock"))
    work = Path(payload["work"])
    items = payload["items"]

    pipe = None
    if mock:
        log(f"[h3:denoise] {now()} mock mode: skip model load ({len(items)} items)")
    else:
        image_dir, _tower_dir = resolve_dirs(payload["runtime"])
        pipe = load_dit(image_dir)

    results = []
    failed = 0
    for item in items:
        try:
            if mock:
                results.append(mock_generate_one(item, work))
            else:
                results.append(real_generate_one(item, work, pipe))
        except Exception as e:  # 逐条隔离：单条失败不中断其余（batch 审计契约）
            failed += 1
            results.append({
                "index": int(item.get("index", -1)),
                "out": item.get("out", ""),
                "failed": True,
                "error": f"{type(e).__name__}: {e}",
            })
            log(f"[h3:denoise] {now()} item {item.get('index')} FAILED: {e}")
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
        log(f"[h3:denoise] {now()} fatal: {type(e).__name__}: {e}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
