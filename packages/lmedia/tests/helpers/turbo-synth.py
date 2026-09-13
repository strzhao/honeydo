"""turbo_merge.py 的合成小 bundle 构建器/校验器（测试用，纯 numpy）。

用法：
  turbo-synth.py build <dir>   # 生成 2-block 迷你 dit.bin/.idx + turbo.safetensors + ref 拷贝
  turbo-synth.py verify <dir>  # 跑完合并后校验 dit-turbo 与期望逐张量一致

迷你形状（合并器按 idx/实张量形状工作，与 H3 真实维度无关）：
  dim=8, qkv=[24,8], out=[8,8], fc1=[32,8], fc2=[8,16]；LoRA rank=4。
"""
import json
import os
import shutil
import struct
import sys

import numpy as np

N_BLOCKS = 2
SHAPES = {"qkv": (24, 8), "out": (8, 8), "fc1": (32, 8), "fc2": (8, 16)}
RANK = 4
# lightx2v 命名 -> (lora_A 形状, lora_B 形状)（[r,K] / [N,r]）
LORA_SHAPES = {
    "attn.to_q": ((RANK, 8), (8, RANK)),
    "attn.to_k": ((RANK, 8), (8, RANK)),
    "attn.to_v": ((RANK, 8), (8, RANK)),
    "attn.to_out.0": ((RANK, 8), (8, RANK)),
    "ff.net.0.proj": ((RANK, 8), (32, RANK)),
    "ff.net.2": ((RANK, 16), (8, RANK)),
}


def sym8(w):
    amax = np.abs(w).max(axis=1).astype(np.float32)
    s = np.where(amax > 0, amax / 127.0, np.float32(1.0))
    q = np.rint(w / s[:, None]).clip(-127, 127).astype(np.int8)
    return q, s


def to_bf16_bytes(a):
    u = np.asarray(a, np.float32).view(np.uint32) >> 16
    return u.astype(np.uint16).tobytes()


class Writer:
    """与 turbo_merge.Writer 相同的 blob 布局（64B 对齐 + JSON idx）。"""

    def __init__(self, path):
        self.f = open(path, "wb")
        self.idx = {}

    def put(self, name, arr, dtype):
        a = np.ascontiguousarray(np.asarray(arr).astype(dtype))
        off = self.f.tell()
        pad = (-off) % 64
        self.f.write(b"\0" * pad)
        off += pad
        self.f.write(a.tobytes())
        self.idx[name] = {"off": off, "len": a.nbytes,
                          "dt": np.dtype(dtype).name, "shape": list(a.shape)}

    def close(self, meta):
        self.idx["__meta__"] = meta
        self.f.close()


def write_safetensors(path, tensors):
    """tensors: {name: (bf16 array)}。手工拼最小 safetensors（全 BF16）。"""
    header, blob, off = {}, b"", 0
    for name, arr in tensors.items():
        raw = to_bf16_bytes(arr)
        header[name] = {"dtype": "BF16", "shape": list(arr.shape),
                        "data_offsets": [off, off + len(raw)]}
        blob += raw
        off += len(raw)
    hb = json.dumps(header).encode()
    hb += b" " * ((8 - len(hb) % 8) % 8)  # header 对齐到 8 字节
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hb)))
        f.write(hb)
        f.write(blob)


def read_bundle(prefix):
    idx = json.load(open(prefix + ".idx"))
    idx.pop("__meta__")
    blob = np.memmap(prefix + ".bin", dtype=np.uint8, mode="r")

    def get(name):
        r = idx[name]
        a = np.frombuffer(blob[r["off"]:r["off"] + r["len"]].tobytes(),
                          dtype=np.dtype(r["dt"])).reshape(r["shape"])
        return a.copy()

    return idx, get, blob


def build(dirpath):
    os.makedirs(dirpath, exist_ok=True)
    for tag in ("dit", "ref"):
        rng = np.random.default_rng(42)  # dit 与 ref 必须同内容（ref 是期望基准）
        w = Writer(os.path.join(dirpath, tag + ".bin"))
        for i in range(N_BLOCKS):
            for g, (n, k) in SHAPES.items():
                base = (rng.standard_normal((n, k)) * 0.3).astype(np.float32)
                q, s = sym8(base)
                w.put(f"L{i}.{g}.w", q, np.int8)
                w.put(f"L{i}.{g}.s", s, np.float32)
            for t in ("n1", "n2", "qn", "kn"):
                w.put(f"L{i}.{t}", rng.standard_normal(8).astype(np.float16), np.float16)
            w.put(f"L{i}.adaw", rng.standard_normal((64, 2)).astype(np.float16), np.float16)
            w.put(f"L{i}.adab", rng.standard_normal(64).astype(np.float16), np.float16)
        w.put("adaln_t_table", rng.standard_normal((16, 2)).astype(np.float32), np.float32)
        w.put("final_layer.video_out.weight", rng.standard_normal((4, 8)).astype(np.float16), np.float16)
        w.close({"n_blocks": N_BLOCKS, "dim": 8, "source": "synthetic"})
        json.dump(w.idx, open(os.path.join(dirpath, tag + ".idx"), "w"))

    tensors = {}
    for i in range(N_BLOCKS):
        for tail, (sa, sb) in LORA_SHAPES.items():
            tensors[f"transformer_blocks.{i}.{tail}.lora_A.default.weight"] = \
                (rng.standard_normal(sa) * 0.1).astype(np.float32)
            tensors[f"transformer_blocks.{i}.{tail}.lora_B.default.weight"] = \
                (rng.standard_normal(sb) * 0.1).astype(np.float32)
    # 故意混入无法消费的 key：refiner（形状不兼容被跳过）+ 全未知命名
    tensors["token_refiner.refiner_blocks.0.attn.to_q.lora_A.default.weight"] = \
        (rng.standard_normal((RANK, 99)) * 0.1).astype(np.float32)
    tensors["some.unknown.key.lora_A.default.weight"] = \
        (rng.standard_normal((RANK, 7)) * 0.1).astype(np.float32)
    write_safetensors(os.path.join(dirpath, "turbo.safetensors"), tensors)


def verify(dirpath):
    idx, get, _ = read_bundle(os.path.join(dirpath, "ref"))
    midx, mget, _ = read_bundle(os.path.join(dirpath, "dit-turbo"))
    with open(os.path.join(dirpath, "dit-turbo.idx")) as f:
        meta = json.load(f)["__meta__"]
    assert meta.get("turbo_lora") == "turbo.safetensors", meta
    assert meta.get("turbo_merged") == N_BLOCKS * 4, meta

    st = read_safetensors(os.path.join(dirpath, "turbo.safetensors"))
    GEMM_TO_TAILS = {
        "qkv": ("attn.to_q", "attn.to_k", "attn.to_v"),   # 行拼接 q|k|v
        "out": ("attn.to_out.0",),
        "fc1": ("ff.net.0.proj",),
        "fc2": ("ff.net.2",),
    }
    for i in range(N_BLOCKS):
        for g, (n, k) in SHAPES.items():
            w8 = get(f"L{i}.{g}.w").astype(np.float32)
            s = get(f"L{i}.{g}.s").astype(np.float32)
            parts = []
            for tail in GEMM_TO_TAILS[g]:
                a = st[f"transformer_blocks.{i}.{tail}.lora_A.default.weight"]
                b = st[f"transformer_blocks.{i}.{tail}.lora_B.default.weight"]
                parts.append(b.astype(np.float32) @ a.astype(np.float32))
            delta = np.concatenate(parts, axis=0) if len(parts) > 1 else parts[0]
            eq, es = sym8(w8 * s[:, None] + delta)
            mq, ms = mget(f"L{i}.{g}.w"), mget(f"L{i}.{g}.s")
            assert mq.dtype == np.int8 and np.array_equal(mq, eq), f"L{i}.{g}.w mismatch"
            assert np.array_equal(ms, es), f"L{i}.{g}.s mismatch"
        for t in ("n1", "n2", "qn", "kn", "adaw", "adab"):
            assert np.array_equal(get(f"L{i}.{t}"), mget(f"L{i}.{t}")), f"L{i}.{t} changed"
    assert np.array_equal(get("adaln_t_table"), mget("adaln_t_table"))
    assert get("final_layer.video_out.weight").tobytes() == \
        mget("final_layer.video_out.weight").tobytes()
    print("VERIFY PASS")


def read_safetensors(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        hdr = json.loads(f.read(n))
    base = 8 + n
    mm = np.memmap(path, dtype=np.uint8, mode="r")
    out = {}
    for k, e in hdr.items():
        s, t = e["data_offsets"]
        u = mm[base + s:base + t].copy().view(np.uint16).astype(np.uint32) << 16
        out[k] = u.view(np.float32).reshape(e["shape"])
    return out


if __name__ == "__main__":
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "build":
        shutil.rmtree(d, ignore_errors=True)
        build(d)
        print("BUILD OK")
    elif cmd == "verify":
        verify(d)
    else:
        sys.exit(f"unknown cmd {cmd}")
