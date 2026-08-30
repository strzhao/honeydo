"""teacache.py — TeaCache 步缓存（Qwen-Image 系专用，纯 PyTorch，MPS 兼容）。
 * 算法：相邻去噪步 block0 调制输入（信号 A）的 rel-L1 → 标定多项式 → 累计值 < 阈值则
 *   跳过 60 个 transformer block（body），用「当前 img_in 输出 + 上次 body 残差」过 tail
 *   （norm_out+proj_out 很便宜）。不动权重/步数/CFG/调度器。
 * 系数：mlx-teacache 在 Apple Silicon 的实测标定值（Signal A 原点约束拟合，R²=0.85；
 *   阈值 0.30 → 24/48 步跳过、SSIM 0.987 视觉无损；SSIM 随阈值无悬崖衰减）。
 *   ⚠️ 不要用 ComfyUI/vllm 的 [-450,280,-45,3.2,-0.02]：标定域不同且常数项为负，
 *   我们的 rel 尺度下 acc 一路负漂 → 无限跳过 → 输出浆糊（2026-08-29 实录）。
 * CFG：diffusers Qwen 管线每步正/负两次调用、hidden_states 完全相同 → 每步共享一次
 *   门控决策（与 mlx-teacache「shared CFG gate」一致），残差缓存按流分开。
 * 绕行：batch>1（--num>1 或未来 CFG 合批）直接 passthrough，不缓存。
 * 重置：scheduler 时间步单调递减，t 回升 = 新生成 → 全部重置（daemon 跨任务安全）。
 * 实现：forward 拆 prelude/body/tail 三段复刻（与 diffusers 0.36 transformer_qwenimage.py
 *   逐行对齐）；skip 也要跑 prelude/tail（<2% 前向耗时）。
 * 参考：TeaCache（CVPR2025, arXiv 2411.19108）；github.com/IonDen/mlx-teacache（Qwen 标定）。
"""
import math
import os
import sys

import torch
from diffusers.models.modeling_outputs import Transformer2DModelOutput
from diffusers.models.transformers.transformer_qwenimage import compute_text_seq_len_from_mask

TRACE = os.environ.get("LMEDIA_TEACACHE_TRACE") == "1"

# mlx-teacache Signal A 原点约束拟合（scripts/_calibration_qwen.json，2026-06 标定；c4..c0，c0=0）
QWEN_COEFFS = (-12.954226906135869, 8.883805167578382, -0.9363839862290331, 1.4538816050570036, 0.0)

DEFAULT_THRESHOLD = 0.30  # mlx-teacache 阈值扫描：SSIM 0.995@0.20 / 0.987@0.30 / 0.981@0.40
DEFAULT_WARMUP_STEPS = 4  # 前 N 步（每流前 N 次调用）强制 compute——结构形成期禁缓存
                          #（cache-dit 对 Qwen 默认 warmup=8；2048 大图均值信号对构图大改不敏感，
                          #  无 warmup 时早期误跳 → 轨迹锁死在错误构图，2026-08-30 实录）


def _rescale(x: float) -> float:
    c = QWEN_COEFFS
    return c[0] * x**4 + c[1] * x**3 + c[2] * x**2 + c[3] * x + c[4]


class TeaCache:
    """transformer.forward 级钩子。attach 后按 enabled/thresh 动态开关，per-job 复用。"""

    def __init__(self, thresh: float = DEFAULT_THRESHOLD, warmup: int = DEFAULT_WARMUP_STEPS):
        self.thresh = float(thresh)
        self.warmup = int(warmup)  # 每流前 warmup 次调用强制 compute
        self.enabled = True
        # 双流（0=正 1=负）各自的残差缓存；信号/决策按步共享
        self._streams = [self._stream(), self._stream()]
        self._prev_signal: torch.Tensor | None = None
        self._acc = 0.0
        self._step_t: float | None = None
        self._step_count = 0
        self._pending: tuple[bool, torch.Tensor] | None = None  # (skip?, signal) 给本步第二次调用
        self._last_t: float | None = None
        self.calls = 0
        self.skips = 0

    @staticmethod
    def _stream() -> dict:
        return {"res_img": None, "res_enc": None}

    def reset(self) -> None:
        self._streams = [self._stream(), self._stream()]
        self._prev_signal = None
        self._acc = 0.0
        self._step_t = None
        self._step_count = 0
        self._pending = None
        self._last_t = None

    def begin_job(self) -> None:
        """每个生成任务开始：清零统计（缓存状态靠时间步回升自动重置）。"""
        self.calls = 0
        self.skips = 0

    def stats(self) -> dict:
        return {"calls": self.calls, "skips": self.skips, "thresh": self.thresh}

    # ---- forward 三段复刻（diffusers 0.36 QwenImageTransformer2DModel）----

    @staticmethod
    def _prelude(m, hidden_states, encoder_hidden_states, encoder_hidden_states_mask,
                 timestep, img_shapes, guidance, additional_t_cond):
        hs = m.img_in(hidden_states)
        t = timestep.to(hs.dtype)
        modulate_index = None
        if m.zero_cond_t:
            t = torch.cat([t, t * 0], dim=0)
            modulate_index = torch.tensor(
                [[0] * math.prod(s[0]) + [1] * sum(math.prod(x) for x in s[1:]) for s in img_shapes],
                device=t.device, dtype=torch.int,
            )
        enc = m.txt_in(m.txt_norm(encoder_hidden_states))
        text_seq_len, _, enc_mask = compute_text_seq_len_from_mask(enc, encoder_hidden_states_mask)
        if guidance is not None:
            guidance = guidance.to(hs.dtype) * 1000
        temb = (
            m.time_text_embed(t, hs, additional_t_cond)
            if guidance is None
            else m.time_text_embed(t, guidance, hs, additional_t_cond)
        )
        rope = m.pos_embed(img_shapes, max_txt_seq_len=text_seq_len, device=hs.device)
        return hs, enc, enc_mask, t, temb, rope, modulate_index

    @staticmethod
    def _signal(m, hs, temb, modulate_index, img_shapes):
        """信号 A：block0 img 流调制输入的「主图 token」部分（条件图 token 恒定，会稀释 rel-L1
        导致过度跳过——2026-08-29 实录 4ref 全序列信号把 57% 调用错误跳过）。"""
        with torch.no_grad():
            block = m.transformer_blocks[0]
            img_mod1, _ = block.img_mod(temb).chunk(2, dim=-1)
            modulated, _ = block._modulate(block.img_norm1(hs), img_mod1, modulate_index)
            main_lens = [math.prod(s[0]) for s in img_shapes]
            return torch.cat([modulated[b, : main_lens[b]].reshape(-1) for b in range(len(main_lens))])

    @staticmethod
    def _run_body(m, hs, enc, enc_mask, temb, rope, modulate_index, attention_kwargs, controlnet_block_samples):
        for index_block, block in enumerate(m.transformer_blocks):
            enc, hs = block(
                hidden_states=hs,
                encoder_hidden_states=enc,
                encoder_hidden_states_mask=enc_mask,
                temb=temb,
                image_rotary_emb=rope,
                joint_attention_kwargs=attention_kwargs,
                modulate_index=modulate_index,
            )
            if controlnet_block_samples is not None:
                import numpy as np

                interval = int(np.ceil(len(m.transformer_blocks) / len(controlnet_block_samples)))
                hs = hs + controlnet_block_samples[index_block // interval]
        return enc, hs

    @staticmethod
    def _tail(m, hs, temb):
        t = temb.chunk(2, dim=0)[0] if m.zero_cond_t else temb
        return m.proj_out(m.norm_out(hs, t))

    def attach(self, transformer) -> None:
        tc = self
        m = transformer

        def forward(
            hidden_states,
            encoder_hidden_states=None,
            encoder_hidden_states_mask=None,
            timestep=None,
            img_shapes=None,
            guidance=None,
            attention_kwargs=None,
            controlnet_block_samples=None,
            additional_t_cond=None,
            return_dict=True,
        ):
            # batch>1（--num 或 CFG 合批）绕行：残差按整批缓存语义不安全
            if not tc.enabled or hidden_states.size(0) != 1:
                return _full()

            t_val = float(timestep.reshape(-1)[0].item())
            if tc._last_t is None or t_val > tc._last_t:  # 时间步回升 = 新生成
                tc.reset()
            new_step = t_val != tc._step_t
            tc._last_t = t_val
            tc._step_t = t_val
            tc.calls += 1

            hs, enc, enc_mask, t, temb, rope, modulate_index = self._prelude(
                m, hidden_states, encoder_hidden_states, encoder_hidden_states_mask,
                timestep, img_shapes, guidance, additional_t_cond,
            )

            if new_step:
                signal = self._signal(m, hs, temb, modulate_index, img_shapes)
                tc._step_count += 1
                skip = False
                if tc._step_count <= tc.warmup:
                    pass  # 结构形成期强制 compute（大图均值信号对构图大改不敏感，禁跳）
                elif tc._prev_signal is not None:
                    rel = ((signal - tc._prev_signal).abs().mean()
                           / (tc._prev_signal.abs().mean() + 1e-9)).item()
                    tc._acc += _rescale(rel)
                    skip = tc._acc < tc.thresh
                    if TRACE:
                        print(f"[teacache] t={t_val:.1f} rel={rel:.4f} acc={tc._acc:.3f} "
                              f"{'SKIP' if skip else 'compute'}", file=sys.stderr)
                tc._pending = (skip, signal)
                stream = 0
            else:
                skip, signal = tc._pending
                stream = 1
                if TRACE:
                    print(f"[teacache] t={t_val:.1f} 负流共享决策 {'SKIP' if skip else 'compute'}",
                          file=sys.stderr)

            st = tc._streams[stream]
            if skip and st["res_img"] is not None:
                tc.skips += 1
                out = self._tail(m, hs + st["res_img"], temb)
                return Transformer2DModelOutput(sample=out) if return_dict else (out,)

            enc_in, hs_in = enc, hs
            enc, hs = self._run_body(m, hs, enc, enc_mask, temb, rope, modulate_index,
                                     attention_kwargs, controlnet_block_samples)
            st["res_img"] = hs - hs_in
            st["res_enc"] = enc - enc_in
            if new_step:
                tc._prev_signal = signal
                tc._acc = 0.0
            out = self._tail(m, hs, temb)
            return Transformer2DModelOutput(sample=out) if return_dict else (out,)

        def _full():
            return TeaCache._orig_forward(
                m,
                hidden_states, encoder_hidden_states, encoder_hidden_states_mask, timestep,
                img_shapes, guidance, attention_kwargs, controlnet_block_samples,
                additional_t_cond, return_dict,
            )

        forward._orig = m.forward  # 保留引用防 GC 歧义
        m.forward = forward

    # 由 attach 时填充
    _orig_forward = None


def attach_teacache(transformer, thresh: float = DEFAULT_THRESHOLD, warmup: int = DEFAULT_WARMUP_STEPS) -> TeaCache:
    tc = TeaCache(thresh=thresh, warmup=warmup)
    TeaCache._orig_forward = transformer.forward
    tc.attach(transformer)
    return tc


def apply_teacache(pipe, cfg: dict) -> TeaCache | None:
    """per-job 开关：cfg['teaCache'] 为 {thresh?, warmup?} 或 true 时启用；否则挂起（零开销 passthrough）。
    在 gen.py/edit.py 的 run() 开头调用——直跑与 daemon（serve.py run_job → run）两条路同时覆盖。"""
    tc_cfg = cfg.get("teaCache")
    tc: TeaCache | None = getattr(pipe, "_teacache", None)
    if tc_cfg:
        thresh = tc_cfg.get("thresh", DEFAULT_THRESHOLD) if isinstance(tc_cfg, dict) else DEFAULT_THRESHOLD
        warmup = tc_cfg.get("warmup", DEFAULT_WARMUP_STEPS) if isinstance(tc_cfg, dict) else DEFAULT_WARMUP_STEPS
        if tc is None:
            tc = attach_teacache(pipe.transformer, thresh, warmup)
            pipe._teacache = tc
        else:
            tc.thresh = float(thresh)
            tc.warmup = int(warmup)
        tc.enabled = True
        tc.begin_job()
        return tc
    if tc is not None:
        tc.enabled = False
    return None
