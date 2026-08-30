#!/usr/bin/env python3
"""lmedia sfx worker — Dasheng-AudioGen 本地音效生成（Apache 2.0）

输入: argv[1] = JSON payload {prompt, out, rolls, keepRolls, trim}
输出: stdout 最后一行 JSON {out, rolls, bestRoll, peak, snr, dur, trimmed}

管线：生成(10s/16kHz) → 质量门(峰值≥-25dBFS 且 SNR≥20dB，全废自动加掷≤2) → 剪裁(两级静音检测+簇截断) → 峰值归一-6dBFS
铁律：prompt 必须纯英文场景描述（flan-t5-large 不懂中文 → 中文=人声废片）；禁 afftdn 降噪（填平间隙毁剪裁）
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

GATE_PEAK = -25.0
GATE_SNR = 20.0
PAD = 0.15
PEAK_DB = -6.0


def stats_db(arr):
    peak = 20 * np.log10(np.abs(arr).max() + 1e-12)
    rms = 20 * np.log10(np.sqrt((arr ** 2).mean()) + 1e-12)
    return round(float(peak), 1), round(float(rms), 1)


def probe_dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nk=1:nw=1", path], capture_output=True, text=True).stdout
    return float(out.strip())


def peak_volume_db(path):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    m = re.search(r"max_volume:\s*(-?[\d.]+)\s*dB", r)
    return float(m.group(1)) if m else 0.0


def detect_silences(path, total):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af",
                        "silencedetect=noise=-35dB:d=0.2", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    sil, start = [], None
    for line in r.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            sil.append((start, float(m.group(1))))
            start = None
    if start is not None:
        sil.append((start, total))
    return sil


def build(src, dst, a, b):
    dur = b - a
    gain = PEAK_DB - peak_volume_db(src)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af",
                    f"atrim=start={a:.3f}:end={b:.3f},asetpts=N/SR/TB,"
                    f"afade=t=in:d=0.01,afade=t=out:st={max(0, dur - 0.08):.3f}:d=0.08,"
                    f"volume={gain:.2f}dB,aresample=44100",
                    "-ac", "1", dst], check=True)


def trim(src, dst):
    """两级静音检测 + 首 ≥0.8s 间隙簇截断 → 签名音"""
    total = probe_dur(src)

    def bounds():
        sil = detect_silences(src, total)
        lead = sil[0][1] if sil and sil[0][0] <= 0.05 else 0.0
        tail_start = sil[-1][0] if sil and sil[-1][1] >= total - 0.05 else total
        a = max(0.0, lead - PAD)
        b = min(total, tail_start + PAD)
        return sil, lead, tail_start, a, b

    sil, lead, tail_start, a, b = bounds()
    if b - a < 0.5:  # 电平过低整条判静音 → 宽阈值重试
        sil, lead, tail_start, a, b = None, 0.0, total, 0.0, total
        sil = detect_silences(src, total)  # 简化：不剪首尾只供内部间隙参考
        b = total
    internal = [(s, e) for s, e in (sil or []) if s > lead + 0.3 and e < tail_start - 0.3 and e - s >= 0.8]
    if internal:
        b = min(b, internal[0][0] + PAD)
    if b - a < 0.3:
        a, b = 0.0, total
    build(src, dst, a, b)
    return probe_dur(dst)


def main():
    payload = json.loads(sys.argv[1])
    prompt = payload["prompt"]
    out = payload["out"]
    rolls = int(payload.get("rolls", 3))
    keep_rolls = bool(payload.get("keepRolls", False))
    do_trim = payload.get("trim", True)

    import torch  # 延迟导入，模型加载错误早于重栈
    from transformers import AutoModel

    model = AutoModel.from_pretrained("mispeech/Dasheng-AudioGen", trust_remote_code=True,
                                      torch_dtype=torch.float32).to("mps")
    p = model.compose_prompt(caption=prompt)

    tmpdir = tempfile.mkdtemp(prefix="lmedia-sfx-")
    results = []
    max_attempts = rolls + 2  # 全废自动加掷 ≤2
    for i in range(max_attempts):
        wav = model.generate(p, num_steps=25, guidance_scale=5.0)
        if isinstance(wav, tuple):
            wav = wav[0]
        arr = wav.detach().cpu().float().numpy().squeeze()
        path = os.path.join(tmpdir, f"r{i+1}.wav")
        sf.write(path, arr, 16000)
        peak, rms = stats_db(arr)
        ok = peak >= GATE_PEAK and (peak - rms) >= GATE_SNR
        results.append({"roll": i + 1, "path": path, "peak": peak, "snr": round(peak - rms, 1), "pass": ok})
        print(f"  r{i+1}: peak={peak} snr={peak-rms:.0f} {'✓' if ok else '✗'}", file=sys.stderr, flush=True)
        if i + 1 >= rolls and any(r["pass"] for r in results):
            break

    passing = [r for r in results if r["pass"]]
    best = max(passing, key=lambda r: r["snr"]) if passing else max(results, key=lambda r: r["peak"])

    if do_trim:
        dur = trim(best["path"], out)
    else:
        os.replace(best["path"], out)
        dur = probe_dur(out)

    if keep_rolls:
        keep_dir = out.rsplit(".", 1)[0] + ".rolls"
        os.makedirs(keep_dir, exist_ok=True)
        for r in results:
            dst = os.path.join(keep_dir, f"r{r['roll']}.wav")
            if r["path"] != best["path"] or not do_trim:
                subprocess.run(["cp", r["path"], dst])

    print(json.dumps({
        "out": out, "rolls": len(results), "bestRoll": best["roll"],
        "peak": best["peak"], "snr": best["snr"], "dur": round(dur, 2),
        "gatePassed": bool(passing), "trimmed": bool(do_trim),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
