"""lmedia video gen --fast 的驱动：few-step 蒸馏 bundle + 蒸馏训练用的 flow shift。

Lightning 方案（RH-RunningHub/MiniMax-H3-MultiGPU-Lightning）的本地适配里，
步数蒸馏的推理侧唯一要改的是 sigma 调度的 video shift：v1.x 768p 系蒸馏 LoRA
用 shift 6/3 训练（ModelTC Minimax-h3-Turbo specs），而 mmh3turbo 为基座硬编码
12/3。引擎把 SHIFT_VIDEO 以 def 期默认值（sigmas / timestep_classes）与模块全局
（denoise 的 time_shift_slope 调用）散布在两处，这里统一打补丁后透传给
mmh3turbo.generate.main——产物协议（目录内 video.mp4）与原 CLI 完全一致。
"""
import argparse
import sys

_ap = argparse.ArgumentParser(add_help=False)
_ap.add_argument("--shift-video", type=float, default=6.0,
                 help="蒸馏 LoRA 训练用的 video flow shift（v1.x 768p 系=6；基座=12）")
known, rest = _ap.parse_known_args()

import mmh3turbo.sampler as _sampler      # noqa: E402  (patch 必须在 import 主流程前)
import mmh3turbo.denoise as _denoise      # noqa: E402

_sampler.SHIFT_VIDEO = _denoise.SHIFT_VIDEO = known.shift_video
_sampler.sigmas.__defaults__ = (known.shift_video,)
_sampler.timestep_classes.__defaults__ = (
    known.shift_video, _sampler.SHIFT_AUDIO, False, _sampler.VISUAL_COND_TIMESTEP)

from mmh3turbo.generate import main       # noqa: E402

if not rest:
    sys.exit("缺少生成参数（prompt/-r/--steps/...），用法与 mmh3turbo 相同")
sys.argv = ["mmh3turbo", *rest]
main()
