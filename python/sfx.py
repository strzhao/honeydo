#!/usr/bin/env python3
"""lmedia sfx worker — Dasheng-AudioGen 本地音效生成 + 音频后处理产线（Apache 2.0）

输入: argv[1] = JSON payload，payload["op"] 分发：gen | batch | trim | recut | normalize | accept | abpage | probe
     （无 op 视为 gen，向后兼容既有调用）
输出: stdout **末行单行 compact JSON** 结果（内部禁换行）；人读进度一律走 stderr

管线（gen/batch）：生成(10s/16kHz) → 质量门(峰值≥-25dBFS 且 SNR≥20dB，全废自动加掷≤2) → 剪裁(两级静音检测+簇截断) → 段内两遍峰值归一 -6dBFS
归一铁律：两遍法——先剪到 tmp 测「段内」峰值再增益（整掷峰值归一会让窗口内容低 20dB，已修）
降噪铁律：禁 afftdn（填平间隙毁剪裁）；prompt 必须纯英文场景描述（flan-t5-large 不懂中文 → 中文=人声废片）
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

import numpy as np
import soundfile as sf

GATE_PEAK = -25.0
GATE_SNR = 20.0
PAD = 0.15
PEAK_DB = -6.0
FADE_IN = 0.01
FADE_OUT = 0.08
SILENT_PEAK_DB = -60.0  # 低于此峰值视为全静音（跳过增益，透传副本）
TRIM_MIN_CONTENT = 0.5  # 检测不到内容（整条≈静音）→ 降阈值重试
MIN_RESULT = 0.3        # 成品最小时长，否则回退全段


# ———————————————————————————— 探针 ————————————————————————————

def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def probe_dur(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nk=1:nw=1", path]).stdout
    try:
        return float(out.strip())
    except (ValueError, TypeError):
        raise RuntimeError(f"无法读取音频时长（文件不存在、非音频或已损坏）: {path}")


def probe_sr(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
               "stream=sample_rate", "-of", "default=nk=1:nw=1", path]).stdout
    sr = int(out.strip() or 0)
    if sr <= 0:
        raise RuntimeError(f"无法读取采样率（文件不存在、非音频或已损坏）: {path}")
    return sr


def vol_stats(path):
    """volumedetect → (max_volume, mean_volume) dB；数字静音时 ffmpeg 报 -inf，归一为 -99"""
    r = run(["ffmpeg", "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"])

    def grab(key):
        m = re.search(key + r":\s*(-?[\d.]+|-inf)\s*dB", r.stderr)
        if not m:
            return 0.0
        return -99.0 if m.group(1) == "-inf" else float(m.group(1))

    return grab("max_volume"), grab("mean_volume")


def peak_volume_db(path):
    return vol_stats(path)[0]


def integrated_lufs(path):
    r = run(["ffmpeg", "-hide_banner", "-i", path, "-af", "ebur128", "-f", "null", "-"])
    if "Summary:" not in r.stderr:
        return None
    m = re.search(r"I:\s*(-?[\d.]+)\s*LUFS", r.stderr.split("Summary:")[-1])
    return float(m.group(1)) if m else None


def detect_silences(path, total, thresh_db=-35.0, min_d=0.2):
    """silencedetect → [(start, end), ...]；文件末尾未闭合的静音补 total"""
    r = run(["ffmpeg", "-hide_banner", "-i", path, "-af",
             f"silencedetect=noise={thresh_db:.0f}dB:d={min_d}", "-f", "null", "-"])
    sil, start = [], None
    for line in r.stderr.splitlines():
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


def stats_db(arr):
    peak = 20 * np.log10(np.abs(arr).max() + 1e-12)
    rms = 20 * np.log10(np.sqrt((arr ** 2).mean()) + 1e-12)
    return round(float(peak), 1), round(float(rms), 1)


# ———————————————————————————— 生成 ————————————————————————————

def load_model():
    import torch  # 延迟导入：ffmpeg 后处理 op 不需要模型栈
    from transformers import AutoModel
    return AutoModel.from_pretrained("mispeech/Dasheng-AudioGen", trust_remote_code=True,
                                     torch_dtype=torch.float32).to("mps")


def generate_arr(model, composed):
    wav = model.generate(composed, num_steps=25, guidance_scale=5.0)
    if isinstance(wav, tuple):
        wav = wav[0]
    return wav.detach().cpu().float().numpy().squeeze()


def gate_reason(peak, snr):
    low_peak, low_snr = peak < GATE_PEAK, snr < GATE_SNR
    if low_peak and low_snr:
        return "峰值低于门限且 SNR 不足"
    if low_peak:
        return "峰值低于门限"
    if low_snr:
        return "SNR 不足"
    return ""


# ———————————————————————————— 两遍归一构建 ————————————————————————————

def build_two_pass(src, dst, a, b, target=PEAK_DB, fade_in=FADE_IN, fade_out=FADE_OUT):
    """两遍法：atrim 到 tmp → 测段内峰值 → gain = target − 段内峰值 → fade+volume+44.1kHz mono"""
    dur = b - a
    tmp = dst + ".cut.wav"
    try:
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af",
                            f"atrim=start={a:.3f}:end={b:.3f},asetpts=N/SR/TB", tmp])
        if r.returncode != 0:
            raise RuntimeError(f"atrim 失败: {src} [{a:.3f},{b:.3f}]")
        gain = target - peak_volume_db(tmp)
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp, "-af",
                            f"afade=t=in:d={fade_in},afade=t=out:st={max(0, dur - fade_out):.3f}:d={fade_out},"
                            f"volume={gain:.2f}dB,aresample=44100",
                            "-ac", "1", dst])
        if r.returncode != 0:
            raise RuntimeError(f"归一编码失败: {dst}")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def trim_bounds(src, total, thresh_db, pad):
    """贴边静音认定（起点 ≤0.05s / 终点 ≥ total−0.05s）+ pad"""
    sil = detect_silences(src, total, thresh_db, 0.2)
    lead = sil[0][1] if sil and sil[0][0] <= 0.05 else 0.0
    tail_start = sil[-1][0] if sil and sil[-1][1] >= total - 0.05 else total
    return sil, lead, tail_start, max(0.0, lead - pad), min(total, tail_start + pad)


def signature_window(src, total, thresh_db=-35.0, pad=PAD):
    """签名音剪裁窗口：两级阈值回退（thresh → thresh−15 → 不剪）+ 首个 ≥0.8s 内部间隙截断。
    gen / batch / trim 三路共用同一实现。返回 (a, b, b_cut)：b=去首尾静音后的窗口终点，b_cut=簇截断后的 short 终点。"""
    sil, lead, tail_start, a, b = trim_bounds(src, total, thresh_db, pad)
    if b - a < TRIM_MIN_CONTENT:  # 电平过低整条判静音 → 宽阈值重试
        sil, lead, tail_start, a, b = trim_bounds(src, total, thresh_db - 15.0, pad)
    if b - a < TRIM_MIN_CONTENT:  # 仍检不出 → 不剪（sil 保留供内部间隙参考）
        sil, lead, tail_start, a, b = detect_silences(src, total, thresh_db, 0.2), 0.0, total, 0.0, total
    b_cut = b
    internal = [(s, e) for s, e in sil if s > lead + 0.3 and e < tail_start - 0.3 and e - s >= 0.8]
    if internal:
        b_cut = min(b, internal[0][0] + pad)
    return a, b, b_cut


def write_ops(path, op, argv, info_in, info_out):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"op": op, "argv": argv, "in": info_in, "out": info_out,
                   "at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
                  f, ensure_ascii=False, indent=1)


# ———————————————————————————— 剪裁 / 重剪 ————————————————————————————

def trim_file(src, thresh_db=-35.0, pad=PAD):
    """两级阈值（thresh → thresh−15 → 不剪）+ 内部间隙 ≥0.8s 簇截断 → <base>.trim.wav + <base>.short.wav"""
    total = probe_dur(src)
    a, b, b_cut = signature_window(src, total, thresh_db, pad)

    base = os.path.splitext(src)[0]
    trim_path, short_path = f"{base}.trim.wav", f"{base}.short.wav"
    peak_in = peak_volume_db(src)
    build_two_pass(src, trim_path, a, b)
    trim_dur = probe_dur(trim_path)

    if b_cut < b:
        build_two_pass(src, short_path, a, b_cut)
        short_dur = probe_dur(short_path)
    else:
        shutil.copy2(trim_path, short_path)
        short_dur = trim_dur

    write_ops(f"{base}.ops.json", "trim",
              {"thresh": f"{thresh_db:.0f}dB", "pad": pad},
              {"path": src, "dur": round(total, 3), "peak": peak_in},
              {"trim": {"path": trim_path, "dur": round(trim_dur, 3), "peak": peak_volume_db(trim_path)},
               "short": {"path": short_path, "dur": round(short_dur, 3), "peak": peak_volume_db(short_path)},
               "cut": [round(a, 3), round(b, 3)]})
    return {"in": src, "trim": trim_path, "short": short_path,
            "durIn": round(total, 2), "durTrim": round(trim_dur, 2), "durShort": round(short_dur, 2),
            "peakIn": peak_in, "peakOut": peak_volume_db(trim_path)}


def recut_file(src, thresh_db=-40.0, min_d=0.15, cap=3.5, pad=PAD):
    """灵敏重剪：-40dB/0.15s 检测 + 内部间隙 ≥0.45s 截断 + cap 硬帽 → <base>.short.wav 覆写"""
    total = probe_dur(src)
    sil = detect_silences(src, total, thresh_db, min_d)
    lead = sil[0][1] if sil and sil[0][0] <= 0.05 else 0.0
    tail = sil[-1][0] if sil and sil[-1][1] >= total - 0.05 else total
    a, b = max(0.0, lead - pad), min(total, tail + pad)
    if b - a < TRIM_MIN_CONTENT:
        a, b, lead, tail = 0.0, total, 0.0, total
    internal = [(s, e) for s, e in sil if s > a + 0.3 and e < b - 0.3 and e - s >= 0.45]
    if internal:
        b = min(b, internal[0][0] + PAD)
    if b - a > cap:  # 硬帽（留 0.2s 给淡出）
        b = a + cap - 0.2
    if b - a < MIN_RESULT:
        a, b = 0.0, total

    base = os.path.splitext(src)[0]
    dst = f"{base}.short.wav"
    peak_in = peak_volume_db(src)
    build_two_pass(src, dst, a, b)
    dur_out, peak_out = probe_dur(dst), peak_volume_db(dst)
    write_ops(f"{dst}.ops.json", "recut",
              {"thresh": f"{thresh_db:.0f}dB", "cap": cap, "minSilence": min_d, "pad": pad},
              {"path": src, "dur": round(total, 3), "peak": peak_in},
              {"path": dst, "dur": round(dur_out, 3), "peak": peak_out, "cut": [round(a, 3), round(b, 3)]})
    return {"in": src, "short": dst, "durIn": round(total, 2), "durOut": round(dur_out, 2),
            "peakIn": peak_in, "peakOut": peak_out}


# ———————————————————————————— 归一 ————————————————————————————

def normalize_file(src, target=PEAK_DB, loudness=None, out_dir=None):
    """sfx 两遍峰值归一（默认 -6dBFS）| ambient loudnorm 两遍 I=<LUFS>:TP=-2:LRA=7 linear=true
    全静音（peak < -60dBFS）→ 跳过增益但写透传副本到 <out>（不产 NaN/削波）"""
    peak_in, _mean = vol_stats(src)
    out = os.path.join(out_dir, os.path.basename(src)) if out_dir else src
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".proc.wav"
    dur_in, sr_in = probe_dur(src), probe_sr(src)
    base = {"in": src, "out": out, "durIn": round(dur_in, 2), "peakIn": peak_in}

    if peak_in < SILENT_PEAK_DB:  # 全静音：透传副本（exit 0 路径，非报错）
        shutil.copy2(src, tmp)
        os.replace(tmp, out)
        return {**base, "mode": "loudness" if loudness is not None else "peak", "skipped": True,
                "reason": f"全静音（峰值 {peak_in:.0f}dB < {SILENT_PEAK_DB:.0f}dB），跳过增益已写透传副本",
                "durOut": round(probe_dur(out), 2), "peakOut": peak_in, "gain": 0.0}

    if loudness is not None:  # loudnorm 两遍；第二遍必须 aresample 回输入采样率（loudnorm 默认升 192k）
        stats = run(["ffmpeg", "-hide_banner", "-i", src, "-af",
                     f"loudnorm=I={loudness}:TP=-2:LRA=7:print_format=json", "-f", "null", "-"])
        m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stats.stderr, re.S)
        if not m:
            raise RuntimeError(f"loudnorm 测量失败: {src}")
        s = json.loads(m.group(0))
        ln = (f"loudnorm=I={loudness}:TP=-2:LRA=7:measured_I={s['input_i']}:measured_TP={s['input_tp']}:"
              f"measured_LRA={s['input_lra']}:measured_thresh={s['input_thresh']}:"
              f"offset={s['target_offset']}:linear=true,aresample={sr_in}")
        if subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af", ln, tmp]).returncode != 0:
            raise RuntimeError(f"loudnorm 应用失败: {src}")
        os.replace(tmp, out)
        return {**base, "mode": "loudness", "skipped": False, "reason": "", "target": loudness,
                "lufsIn": integrated_lufs(src), "lufsOut": integrated_lufs(out),
                "durOut": round(probe_dur(out), 2), "peakOut": peak_volume_db(out), "gain": None,
                "sampleRate": probe_sr(out)}

    gain = target - peak_in
    if abs(gain) < 0.5:  # 已达标：跳过增益但仍写副本
        shutil.copy2(src, tmp)
        os.replace(tmp, out)
        return {**base, "mode": "peak", "skipped": True, "reason": f"已达标（|增益| {abs(gain):.1f}dB < 0.5dB）",
                "durOut": round(probe_dur(out), 2), "peakOut": peak_volume_db(out), "gain": round(gain, 2),
                "sampleRate": probe_sr(out)}
    if subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af",
                       f"volume={gain:.2f}dB", tmp]).returncode != 0:
        raise RuntimeError(f"归一失败: {src}")
    os.replace(tmp, out)
    return {**base, "mode": "peak", "skipped": False, "reason": "", "target": target,
            "durOut": round(probe_dur(out), 2), "peakOut": peak_volume_db(out), "gain": round(gain, 2),
            "sampleRate": probe_sr(out)}


# ———————————————————————————— 验收 / A/B ————————————————————————————

def accept_probe(path, max_dur, min_dur):
    dur = probe_dur(path)
    mx, mn = vol_stats(path)
    flags = []
    if dur > max_dur:
        flags.append("过长")
    if dur < min_dur:
        flags.append("过短")
    if mx > -1.0:
        flags.append("近削波")
    if mx < -8:
        flags.append("偏轻")
    return {"path": path, "dur": round(dur, 2), "peak": mx, "mean": mn,
            "flags": flags, "pass": not flags}


def abpage(groups, out_html):
    """候选音频拷贝到输出目录 ab_files/，html 用相对路径引用（file:// 下绝对路径跨文件媒体受限）"""
    out_dir = os.path.dirname(os.path.abspath(out_html))
    ab_files = os.path.join(out_dir, "ab_files")
    os.makedirs(ab_files, exist_ok=True)
    cards, total = [], 0
    for gi, g in enumerate(groups, 1):
        rows = []
        for ci, cand in enumerate(g.get("candidates", []), 1):
            total += 1
            name = os.path.basename(cand)
            rel = f"ab_files/g{gi:02d}c{ci}_{name}"
            shutil.copy2(cand, os.path.join(out_dir, rel))
            rows.append(f'<div class="track"><span class="tname">{html.escape(g.get("name", f"组{gi}"))} · '
                        f'候选{ci} · {html.escape(name)}</span>\n'
                        f'<audio controls preload="none" src="{html.escape(rel, quote=True)}"></audio></div>')
        cards.append(f'<div class="card"><div class="key">{html.escape(g.get("name", f"组{gi}"))}'
                     f'<span class="note">（{len(rows)} 候选）</span></div>'
                     + "\n".join(rows) + '</div>')
    page = ("<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n"
            "<title>音效 A/B 试听</title>\n<style>\n"
            "body{font-family:-apple-system,\"PingFang SC\",sans-serif;background:#faf9f5;color:#2d3260;"
            "padding:24px;max-width:880px;margin:0 auto;}\n"
            "h1{font-size:19px;margin-bottom:4px}.sub{color:#7d8296;font-size:13px;margin-bottom:16px}\n"
            ".card{background:#fff;border:1px solid #f0efe9;border-radius:12px;padding:12px 16px;margin-bottom:10px}\n"
            ".card .key{font-family:ui-monospace,monospace;font-weight:700}.note{color:#7d8296;font-size:12px;margin-left:8px}\n"
            ".track{display:flex;align-items:center;gap:10px;font-size:13px;padding:3px 0}\n"
            ".tname{color:#7d8296;min-width:220px}audio{flex:1;height:32px}\n</style>\n</head>\n<body>\n"
            "<h1>\U0001F3A7 音效 A/B 试听</h1>\n"
            "<div class=\"sub\">逐候选试听后择优；页面零外部依赖，直接浏览器打开。</div>\n"
            + "\n".join(cards) + "\n</body>\n</html>\n")
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(page)
    return {"out": out_html, "groups": len(groups), "candidates": total,
            "files": [os.path.join(ab_files, f) for f in sorted(os.listdir(ab_files))]}


# ———————————————————————————— ops ————————————————————————————

def op_gen(payload):
    prompt, out = payload["prompt"], payload["out"]
    rolls, keep_rolls = int(payload.get("rolls", 3)), bool(payload.get("keepRolls", False))
    do_trim = payload.get("trim", True)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    t0 = time.time()
    model = load_model()
    composed = model.compose_prompt(caption=prompt)
    tmpdir = tempfile.mkdtemp(prefix="lmedia-sfx-")
    try:
        results, max_attempts = [], rolls + 2  # 全废自动加掷 ≤2
        for i in range(max_attempts):
            arr = generate_arr(model, composed)
            path = os.path.join(tmpdir, f"r{i + 1}.wav")
            sf.write(path, arr, 16000)
            peak, rms = stats_db(arr)
            snr = round(peak - rms, 1)
            ok = peak >= GATE_PEAK and snr >= GATE_SNR
            results.append({"roll": i + 1, "path": path, "peak": peak, "snr": snr, "pass": ok,
                            "reason": gate_reason(peak, snr)})
            print(f"  r{i + 1}: peak={peak} snr={snr:.0f} {'✓' if ok else '✗'}", file=sys.stderr, flush=True)
            if i + 1 >= rolls and any(r["pass"] for r in results):
                break
        passing = [r for r in results if r["pass"]]
        best = max(passing, key=lambda r: r["snr"]) if passing else max(results, key=lambda r: r["peak"])
        if do_trim:
            a, b, _cut = signature_window(best["path"], probe_dur(best["path"]))
            build_two_pass(best["path"], out, a, b)
            dur = probe_dur(out)
        else:
            shutil.copy2(best["path"], out)
            dur = probe_dur(out)
        if keep_rolls:
            keep_dir = out.rsplit(".", 1)[0] + ".rolls"
            os.makedirs(keep_dir, exist_ok=True)
            for r in results:
                shutil.copy2(r["path"], os.path.join(keep_dir, f"r{r['roll']}.wav"))
        emit({"out": out, "rolls": len(results), "bestRoll": best["roll"], "peak": best["peak"],
              "snr": best["snr"], "dur": round(dur, 2), "gatePassed": bool(passing),
              "trimmed": bool(do_trim), "genSec": round(time.time() - t0, 1)})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def op_batch(payload):
    items = payload["items"]
    out_dir = payload["outDir"]
    rolls, keep_rolls = int(payload.get("rolls", 3)), bool(payload.get("keepRolls", False))
    do_trim = payload.get("trim", True)
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    model = load_model()
    report_items = []
    for it in items:
        key, prompt = it["key"], it["prompt"]
        t1 = time.time()
        composed = model.compose_prompt(caption=prompt)
        tmpdir = tempfile.mkdtemp(prefix=f"lmedia-sfx-{key}-")
        try:
            candidates, max_attempts = [], rolls + 2
            for i in range(max_attempts):
                arr = generate_arr(model, composed)
                path = os.path.join(tmpdir, f"r{i + 1}.wav")
                sf.write(path, arr, 16000)
                peak, rms = stats_db(arr)
                snr = round(peak - rms, 1)
                ok = peak >= GATE_PEAK and snr >= GATE_SNR
                candidates.append({"roll": i + 1, "path": path, "peak": peak, "snr": snr, "pass": ok,
                                   "reason": gate_reason(peak, snr)})
                print(f"  · {key} r{i + 1}: peak={peak} snr={snr:.0f} {'✓' if ok else '✗'}",
                      file=sys.stderr, flush=True)
                if i + 1 >= rolls and any(c["pass"] for c in candidates):
                    break  # 掷满基础次数且有合格即收；全废用加掷续命
            passing = [c for c in candidates if c["pass"]]
            best = max(passing, key=lambda c: c["snr"]) if passing else max(candidates, key=lambda c: c["peak"])
            winner_path = os.path.join(out_dir, f"{key}.best.wav")
            if do_trim:
                a, b, _cut = signature_window(best["path"], probe_dur(best["path"]))
                build_two_pass(best["path"], winner_path, a, b)
            else:
                shutil.copy2(best["path"], winner_path)
            if keep_rolls:  # 掷样落盘后报告里的候选路径指向落盘产物（审计可回放）
                for c in candidates:
                    kept = os.path.join(out_dir, f"{key}.r{c['roll']}.wav")
                    shutil.copy2(c["path"], kept)
                    c["path"] = kept
            report_items.append({
                "key": key, "prompt": prompt, "candidates": candidates,
                "winner": {"path": winner_path, "score": best["snr"] if passing else best["peak"]},
                "anyPass": bool(passing), "genSec": round(time.time() - t1, 1)})
            print(f"✓ {key}: best=r{best['roll']} score={best['snr'] if passing else best['peak']} "
                  f"{'PASS' if passing else '⚠️全废待人工'}（{time.time() - t1:.0f}s）", file=sys.stderr, flush=True)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    report = {"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "rolls": rolls, "items": report_items}
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    n_pass = sum(1 for it in report_items if it["anyPass"])
    print(f"完成: {n_pass}/{len(report_items)} key 有合格生成 → {os.path.join(out_dir, 'report.json')}",
          file=sys.stderr, flush=True)
    emit({"dir": os.path.abspath(out_dir), "report": report,
          "items": [{"key": it["key"], "winner": it["winner"], "anyPass": it["anyPass"]} for it in report_items],
          "genSec": round(time.time() - t0, 1)})


def op_trim(payload):
    items = [trim_file(f, thresh_db=float(payload.get("threshDb", -35.0)),
                       pad=float(payload.get("pad", PAD))) for f in payload["files"]]
    emit({"items": items})


def op_recut(payload):
    items = [recut_file(f, thresh_db=float(payload.get("threshDb", -40.0)),
                        min_d=float(payload.get("minSilence", 0.15)),
                        cap=float(payload.get("cap", 3.5))) for f in payload["files"]]
    emit({"items": items})


def op_normalize(payload):
    out_dir = payload.get("outDir")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    items = [normalize_file(f, target=float(payload.get("target", PEAK_DB)),
                            loudness=payload.get("loudness"), out_dir=out_dir) for f in payload["files"]]
    emit({"items": items})


def op_accept(payload):
    items = [accept_probe(f, float(payload.get("maxDur", 4.0)), float(payload.get("minDur", 0.4)))
             for f in payload["files"]]
    emit({"items": items})


def op_abpage(payload):
    emit(abpage(payload["groups"], payload["out"]))


def op_probe(payload):
    items = []
    for f in payload["files"]:
        peak, mean = vol_stats(f)
        items.append({"path": f, "dur": round(probe_dur(f), 3), "peak": peak, "mean": mean,
                      "sampleRate": probe_sr(f)})
    emit({"items": items})


def emit(obj):
    """结果行必须是单行 compact JSON（内部禁换行；TS 取 stdout 末行解析）"""
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), flush=True)


OPS = {"gen": op_gen, "batch": op_batch, "trim": op_trim, "recut": op_recut,
       "normalize": op_normalize, "accept": op_accept, "abpage": op_abpage, "probe": op_probe}


def main():
    payload = json.loads(sys.argv[1])
    op = payload.get("op") or "gen"  # 无 op 视为 gen，向后兼容
    if op not in OPS:
        print(f"未知 op: {op}", file=sys.stderr)
        sys.exit(2)
    OPS[op](payload)


if __name__ == "__main__":
    main()
