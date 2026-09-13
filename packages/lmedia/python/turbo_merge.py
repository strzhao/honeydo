"""turbo LoRA -> int8 DiT bundle 合并器（Lightning 加速档的一次性离线准备）。

RH-RunningHub/MiniMax-H3-MultiGPU-Lightning 的加速实践 = 步数蒸馏 + 注意力/缓存
优化 + 多卡并行；其中能在 Apple Silicon 落地的是**步数蒸馏**：官方蒸馏权重未公开，
社区开源替代是 lightx2v/Minimax-h3-Turbo 等蒸馏 LoRA（详见 USAGE.md 视频块）。
本脚本把蒸馏 LoRA 按 `W += scale * B @ A` 合并进 mmh3turbo 的 per-row int8
bundle，产物用 `--weights` 直接加载（或 `lmedia video gen --fast` 自动走 dit-turbo）。

设计约束（都在 defend 正确性，宁可拒绝也不静默错配）：
- 只支持 lightx2v/Minimax-h3-Turbo 命名（transformer_blocks.*.attn.to_q / to_k /
  to_v / to_out.0 / ff.net.0.proj / ff.net.2）。larryvrh 命名含全宽 adaLN delta，
  对 pruned 基座（8 维曲线基座 adaLN）需要重建时间嵌入，不支持。
- 源 bundle 必须无 SmoothQuant 校准（idx 无 L*.dout / L*.dw2）。带校准的 bundle
  里 out/fc2 权重按输入通道除数缩放、qkv/fc1 除数混在 norm 权重里无法恢复，
  直接合并 delta 是错的 -> 显式报错。
- token_refiner 的 delta 跳过：lightx2v refiner 输入维 5376 != 本引擎 refiner 的
  5120（cond_dim），形状对不上；refiner 只精炼文本条件，跳过影响很小。
- 合并后按输出行重新对称量化（sym8），量化误差 relL2 写进 idx __meta__ 供审计。

纯 numpy 实现（不 import mmh3turbo）：张量形状全部取自 idx/实张量，因此可用
合成小 bundle 做单元测试，也顺带兼容未来维度变化。
"""
import argparse
import json
import os
import re
import struct
import sys

import numpy as np

_NP = {"F32": np.float32, "F16": np.float16, "U8": np.uint8, "I8": np.int8,
       "I32": np.int32, "I64": np.int64, "BOOL": np.bool_}


class Safetensors:
    """最小懒加载 reader；BF16 numpy 不认识，手动升 fp32（convert.py 同款）。"""

    def __init__(self, path):
        self.path = str(path)
        with open(self.path, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            self.header = json.loads(f.read(n))
        self.header.pop("__metadata__", None)
        self.base = 8 + n
        self.mm = np.memmap(self.path, dtype=np.uint8, mode="r")

    def keys(self):
        return self.header.keys()

    def get(self, k):
        e = self.header[k]
        s, t = e["data_offsets"]
        raw = self.mm[self.base + s:self.base + t]
        d = e["dtype"]
        shape = tuple(e["shape"])
        if d == "BF16":
            u = raw.copy().view(np.uint16).astype(np.uint32) << 16
            a = u.view(np.float32)
        elif d in _NP:
            a = raw.copy().view(_NP[d])
        else:
            raise ValueError(f"不支持的 dtype {d}（{k}）")
        return a.reshape(shape)


class Writer:
    """扁平 blob + JSON index，与引擎 Model.load 期望的布局一致（convert.py 同款）。"""

    def __init__(self, path):
        self.f = open(path, "wb")
        self.idx = {}

    def put(self, name, arr, dtype):
        a = np.ascontiguousarray(np.asarray(arr).astype(dtype))
        off = self.f.tell()
        pad = (-off) % 64
        if pad:
            self.f.write(b"\0" * pad)
            off += pad
        self.f.write(a.tobytes())
        self.idx[name] = {"off": off, "len": a.nbytes,
                          "dt": np.dtype(dtype).name, "shape": list(a.shape)}

    def put_raw(self, name, raw, dt, shape):
        """未改动的张量按原字节拷贝（dtype/shape 来自源 idx，不重解释）。"""
        off = self.f.tell()
        pad = (-off) % 64
        if pad:
            self.f.write(b"\0" * pad)
            off += pad
        self.f.write(raw)
        self.idx[name] = {"off": off, "len": len(raw),
                          "dt": dt, "shape": list(shape)}

    def close(self, meta):
        self.idx["__meta__"] = meta
        self.f.close()


def sym8(w):
    """per-output-row 对称 int8。w:[N,K] -> (int8[N,K], f32[N])（convert.py 同款）。"""
    amax = np.abs(w).max(axis=1).astype(np.float32)
    s = np.where(amax > 0, amax / 127.0, np.float32(1.0))
    q = np.rint(w / s[:, None]).clip(-127, 127).astype(np.int8)
    return q, s


# lightx2v 命名 -> bundle GEMM 标签；qkv 三个 delta 按行拼回 fused 权重
LORA_TAG = {
    "attn.to_q": "qkv", "attn.to_k": "qkv", "attn.to_v": "qkv",
    "attn.to_out.0": "out",
    "ff.net.0.proj": "fc1",
    "ff.net.2": "fc2",
}
TAG_TO_TAILS = {g: [t for t, gg in LORA_TAG.items() if gg == g]
                for g in set(LORA_TAG.values())}


def parse_lora_keys(keys):
    """-> {block_index: {lora_tail: {'A': key, 'B': key}}}，无法归类的 key 原样返回。"""
    pat = re.compile(r"^(.*?)\.lora_([AB])(?:\.\w+)?\.weight$")
    parsed, unknown = {}, []
    for k in keys:
        m = pat.match(k)
        if not m:
            unknown.append(k)
            continue
        base, ab = m.group(1), m.group(2)
        block = None
        bm = re.match(r"^transformer_blocks\.(\d+)\.(.+)$", base)
        if bm:
            block, tail = int(bm.group(1)), bm.group(2)
        elif base.startswith("token_refiner."):
            continue  # shape 不兼容，见模块 docstring
        else:
            unknown.append(k)
            continue
        if tail not in LORA_TAG:
            unknown.append(k)
            continue
        entry = parsed.setdefault(block, {}).setdefault(tail, {})
        entry[ab] = k
    return parsed, unknown


def merge(lora_path, bundle, out, scale=1.0, nfe=None):
    idx = json.load(open(bundle + ".idx"))
    meta = idx.pop("__meta__", {})
    for i in range(int(meta.get("n_blocks", 0))):
        if f"L{i}.dout" in idx or f"L{i}.dw2" in idx:
            sys.exit(
                f"源 bundle 带 SmoothQuant 校准（L{i}.dout/dw2 存在）：delta 需要"
                f"按除数缩放，本实现不支持。请换用未校准 bundle（mmh3turbo-bundles）。")
    blob = np.memmap(bundle + ".bin", dtype=np.uint8, mode="r")
    lora = Safetensors(lora_path)
    parsed, unknown = parse_lora_keys(lora.keys())
    if not parsed:
        sys.exit("LoRA 里没有可识别的 transformer_blocks.* delta"
                 f"（只支持 lightx2v 命名）；未识别 key 例: {unknown[:3]}")

    def read_bundle(name):
        r = idx[name]
        return np.frombuffer(blob[r["off"]:r["off"] + r["len"]].tobytes(),
                             dtype=np.dtype(r["dt"])).reshape(r["shape"])

    w = Writer(out + ".bin")
    errs, merged_list = [], []
    for name in idx:
        r = idx[name]
        m = re.match(r"^L(\d+)\.(qkv|out|fc1|fc2)\.(w|s)$", name)
        if not (m and int(m.group(1)) in parsed):
            w.put_raw(name, blob[r["off"]:r["off"] + r["len"]].tobytes(),
                      r["dt"], r["shape"])
            continue
        i, tag, part = int(m.group(1)), m.group(2), m.group(3)
        if part == "s":
            continue  # 已随同名 .w 一起写出
        block_lora = parsed[i]
        missing = [t for t in TAG_TO_TAILS[tag] if t not in block_lora]
        if missing:
            sys.exit(f"L{i}.{tag}: LoRA 缺少 {missing} 的 delta，拒绝部分合并")
        w8 = read_bundle(f"L{i}.{tag}.w").astype(np.float32)
        s = read_bundle(f"L{i}.{tag}.s").astype(np.float32)
        target = w8 * s[:, None]
        deltas = []
        for tail in TAG_TO_TAILS[tag]:
            a = lora.get(block_lora[tail]["A"]).astype(np.float32)
            b = lora.get(block_lora[tail]["B"]).astype(np.float32)
            deltas.append(b @ a)
        delta = np.concatenate(deltas, axis=0) if len(deltas) > 1 else deltas[0]
        if delta.shape != target.shape:
            sys.exit(f"L{i}.{tag}: delta {delta.shape} 与 bundle 权重 {target.shape} "
                     f"形状不符——LoRA 与该 bundle 不是同一架构，拒绝合并")
        target = target + scale * delta
        q, s_new = sym8(target)
        rec = q.astype(np.float32) * s_new[:, None]
        errs.append(float(np.linalg.norm(rec - target) / np.linalg.norm(target)))
        w.put(f"L{i}.{tag}.w", q, np.int8)
        w.put(f"L{i}.{tag}.s", s_new, np.float32)
        merged_list.append(f"L{i}.{tag}")

    for name in merged_list:
        print(f"  merged {name}", flush=True)
    rel = {"mean": float(np.mean(errs)), "max": float(np.max(errs))} if errs \
        else {"mean": 0.0, "max": 0.0}
    meta.update({"turbo_lora": os.path.basename(lora_path), "turbo_scale": scale,
                 "turbo_relL2": rel, "turbo_merged": len(merged_list)})
    if nfe is not None:
        meta["turbo_nfe"] = nfe
    w.close(meta)
    json.dump(w.idx, open(out + ".idx", "w"))
    print(f"wrote {out}.bin  {os.path.getsize(out + '.bin') / 2**30:.2f} GiB, "
          f"{len(merged_list)} GEMM 已合并（relL2 mean {rel['mean']:.5f} max {rel['max']:.5f}）")
    if unknown:
        print(f"  [未消费 LoRA key x{len(unknown)}] {unknown[:4]}（refiner/未支持命名，已跳过）")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lora", required=True, help="蒸馏 LoRA safetensors（lightx2v 命名）")
    ap.add_argument("--bundle", default=os.path.expanduser("~/.cache/mmh3turbo/dit"),
                    help="源 int8 bundle 前缀（dit.bin/dit.idx）")
    ap.add_argument("--out", default=os.path.expanduser("~/.cache/mmh3turbo/dit-turbo"),
                    help="输出 bundle 前缀")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="LoRA 强度（蒸馏配方固定 1.0）")
    ap.add_argument("--nfe", type=int, default=None,
                    help="该蒸馏 LoRA 的推荐去噪步数（写入 bundle meta，gen --fast 读它做默认步数）")
    a = ap.parse_args()
    if not os.path.exists(a.bundle + ".bin") or not os.path.exists(a.bundle + ".idx"):
        sys.exit(f"源 bundle 不存在: {a.bundle}.bin/.idx（先 lmedia video setup）")
    if not os.path.exists(a.lora):
        sys.exit(f"LoRA 文件不存在: {a.lora}")
    merge(a.lora, a.bundle, a.out, a.scale, a.nfe)


if __name__ == "__main__":
    main()
