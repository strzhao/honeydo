# Decisions

### [2026-09-18] gcli quota 染色阈值与色值对齐 statusline-sage
<!-- tags: gcli, quota, color, design-system -->
**Background**: gcli provider picker 需要按用量给 quota 上色（快用完显红），用户明确要求与 statusline-sage 观感统一。
**Choice**: 阈值照搬 statusline-sage（≥85 朱红 / ≥60 琥珀 / else 苔绿），色值直接用其 Sage truecolor 三色（#D94F3D/#D4920A/#3A7D68）；每个窗口（5h/wk）独立判定。
**Alternatives rejected**: ANSI 16 色语义色（31/33/32）——随终端主题自适应但与 statusline 观感割裂；因用户终端已验证 truecolor（statusline-sage 正在用）而落选。
**Trade-offs**: 固定 RGB 在浅色终端主题下对比度未验证；色彩决策单点在 `levelColor`，未来可一处切换。
