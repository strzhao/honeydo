"""bootstrap_char.py — 数据不足角色的自举：官方 ref + Edit-2509 生成 12 张多样场景图。
用法: python bootstrap_char.py <charKey>
产出: ~/ml/lb-local-gen/lora-data/<charKey>-boot/boot-XX.png
"""
import json
import os
import sys
import time

import torch
from diffusers import QwenImageEditPlusPipeline
from PIL import Image

CHAR_KEY = sys.argv[1]
REPO = os.path.expanduser("~/workspace/little-bee")
REG = json.load(open(os.path.join(REPO, "configs/ip/characters.json")))
CH = REG["characters"][CHAR_KEY]
ANCHOR = CH["charAnchor"]
REF_URL = CH["styles"]["watercolor"]["refUrl"]
SNAP_EDIT = os.path.expanduser(
    "~/.cache/huggingface/hub/models--Qwen--Qwen-Image-Edit-2509/snapshots/d3968ef930e841f4c73640fb8afa3b306a78167e"
)
OUT_DIR = os.path.expanduser(f"~/ml/lb-local-gen/lora-data/{CHAR_KEY}-boot")
os.makedirs(OUT_DIR, exist_ok=True)
REF_CACHE = os.path.expanduser(f"~/ml/lb-local-gen/lora-data/{CHAR_KEY}-ref.png")
BAN = "无文字、无汉字、无字母、无数字、无logo、无水印、无标签"

# 12 个多样场景（姿态/环境/情绪/时间全覆盖，避免训练集单一构图偏置）
SCENES = [
    "站在开满小花的草地上开心挥手，阳光明媚",
    "在厨房木桌前坐着吃早餐，桌上有一杯蜂蜜牛奶",
    "下雨天举着一片大荷叶当伞走在小路上，雨滴落下",
    "在公园里追一只蝴蝶，跑跳姿态充满活力",
    "夜晚坐在床边看绘本故事书，台灯暖光",
    "在沙滩上堆沙堡，背景是大海和蓝天",
    "冬天穿着小围巾在雪地里滚雪球，呼出白气",
    "在树林里捡落叶做花环，秋日暖阳",
    "抱着一个大苹果开心大笑，果园背景",
    "趴在草地上好奇地看一只小蜗牛，特写视角",
    "和好朋友手拉手散步，夕阳暖黄",
    "在自己的小房间里玩积木，房间温馨整洁",
]

if not os.path.exists(REF_CACHE):
    import urllib.request
    urllib.request.urlretrieve(REF_URL, REF_CACHE)

pipe = QwenImageEditPlusPipeline.from_pretrained(SNAP_EDIT, torch_dtype=torch.bfloat16).to("mps")
ref = Image.open(REF_CACHE).convert("RGB")

done = 0
for i, scene in enumerate(SCENES):
    dst = os.path.join(OUT_DIR, f"boot-{i:02d}.png")
    if os.path.exists(dst):
        done += 1
        continue
    t0 = time.time()
    img = pipe(
        image=[ref],
        prompt=(f"保持参考图中的角色外观完全一致（{ANCHOR}）：他/她在{scene}。"
                f"整体画风：水彩儿童绘本插画风格，温暖柔和色调，纸张质感，角色有落地接触阴影，{BAN}"),
        width=1664, height=928, num_inference_steps=20, guidance_scale=4.0,
        generator=torch.Generator(device="mps").manual_seed(1000 + i),
    ).images[0]
    img.save(dst)
    done += 1
    print(f"boot-{i:02d} ok ({time.time()-t0:.0f}s) {done}/{len(SCENES)}", flush=True)
print(f"BOOTSTRAP DONE {CHAR_KEY}: {done} images")
