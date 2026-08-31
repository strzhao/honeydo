# decisions

## 音效产线迁移决策（2026-08-31）

<!-- tags: sfx, dasheng, ssot, little-bee, migration -->

- **算法参数照搬 little-bee 已验证值，不重新发明**：质量门 peak≥-25dBFS/SNR≥20（全废加掷≤2）、trim -35→-50→不剪（PAD 0.15、簇间隙 ≥0.8s）、recut -40dB/0.15s/3.5s 硬帽、sfx 峰值 -6dBFS/ambient loudnorm -23 LUFS。两遍归一（先剪到 tmp 测段内峰值再 gain）是 gen/batch/trim/recut 四路共用的唯一归一实现——「整掷峰值归一错位（窗口内容可低 20dB）」是 little-bee 踩过的真实生产 bug。
- **SSOT 音效库放全局 `~/.config/limg/sfx-library/`**（与 lora 注册表同基目录，用户拍板），`--lib`/`LMEDIA_SFX_LIB` 可覆盖——「让更多场景复用」的动机决定全局默认。与 lora 注册表刻意不同：清单损坏 exit 1 不静默重建（资产库损坏必须人审）。
- **python 侧统一 op 分发**（payload `op` 字段，无 op = gen 向后兼容）：单进程模型一次加载跑整批，继承 dasheng-batch.py 结构优势；同时函数化为将来 daemon 复用铺路（本期不接）。
- 实测：本机 Dasheng 单掷 ~8-16s（远快于 little-bee 记载的 33s/掷），2 prompt × 2 掷冒烟全程 ~30s——批量场景模型加载一次的收益依然显著。

## 退出码分域铁律（2026-08-31）

<!-- tags: cli, exit-code, contract -->

- 文件**不存在**=2（参数域）；文件**存在但内容坏**（空/非法 JSON）=1（`ManifestCorruptError`）——设计期就把两域分开，否则测试断言必然打架。
- commander 框架层例外：缺必填 option → 英文短语 + exit 1（框架约定），契约已补注归桶。
