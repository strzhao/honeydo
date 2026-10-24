# smsctl 使用说明

手机验证码拉取 CLI。从鸿蒙手机（Pura X Max / HOP-AL00，经 hdc）拉取短信会话/验证码，**agent 自助登录/绑定**——触发短信后自己拿码，不再找用户人工转发。

> 何时用它：任何「需要拿手机上的短信验证码」的场景——登录、绑定、授权。触发验证码短信后跑 `smsctl code`，按发送者过滤用 `--from`。
> 边界：**手机须亮屏已解锁**（鸿蒙禁止 hdc 自动解锁锁屏设备，锁屏时拉不到）；只读信息 App 会话列表，不发送/删除任何短信。

## 命令速查

```bash
# 列最近会话（默认 10 条）：发送者 | 时间 | 正文预览
smsctl list
smsctl list 5

# 提取验证码（扫最近会话，最多报 5 条；大小写不敏感按发送者/正文过滤）
smsctl code
smsctl code --from 荣耀

# 调试：拉原始 UI dump JSON，打印本地临时文件路径（文件保留，其余子命令即用即删）
smsctl dump

# hd 主壳入口等价
hd sms list / hd sms code --from 荣耀
```

验证码识别形态（逐会话取首个命中）：`验证码XXXXXX`（允许少量间隔字）→ `码：XXXXXX` → `code: XXXXXX`，4–8 位数字。

## 前提与配置

- **hdc 在线**：`hdc list targets` 能看到设备。hdc 可执行文件用 `SMS_HDC_PATH` 指定，缺省取 PATH 上的 `hdc`
- **手机亮屏已解锁**：锁屏时 `aa start` 报 10106102 被拒（鸿蒙禁止 hdc 自动解锁），工具会明确报「手机锁屏」而不是含糊失败
- **设备 key**：解析顺序 `SMS_HDC_TARGET` env > `~/.smsctl/config.json`（`{"target":"<key>"}`，权限 600）> 恰有一台在线设备时自动选用；多台在线且未配置时报错列出设备
- 拉取原理：`hdc shell` 启动信息 App（`com.ohos.mms`）→ `uitest dumpLayout` 拍平 UI 树 → `hdc file recv` 拉回 Mac → 解析 Text 节点。整页是单个大 RelativeContainer、字段平铺，以时间元素（刚刚/N分钟前/昨天/星期X/日期）为锚点分组：sender 在锚点前、preview 在锚点后

## 硬边界（写进报错文案的）

| 情形 | 表现 | 报错 |
|---|---|---|
| 手机锁屏 | `aa start` 被 10106102 拒（远端已丢弃）→ dump 空树（<1KB） | 「dump 为空树：手机须亮屏且已解锁（鸿蒙禁止 hdc 自动解锁），解锁后重试」 |
| 无设备在线 | `hdc list targets` 为空 | 列出配置方法 |
| 多设备在线 | 未指定 target | 列出在线设备 key，要求指定 |
| 关键词无匹配 | `--from` 过滤后为空 | exit 1 + 「无匹配」 |
| 会话无验证码 | 正则无命中 | exit 0 + 「最近会话中未发现验证码」 |

## 隐私

- 会话内容只在内存里流转；`list`/`code` 的本地临时 dump **即用即删**，不落敏感内容。`dump` 子命令例外——它就是给你拿原始文件调试的，用完自己删
- 设备 key 存 `~/.smsctl/config.json`（仓外），**不进 git**（honeydo 是公开仓，个人设备序列号不入源码）

## 代码结构

- `src/parse.ts` — 纯函数解析（UI 树 → 会话 → 验证码命中），单测覆盖
- `src/device.ts` — hdc 访问 + 设备解析 + 空树守卫
- `src/index.ts` — commander CLI（list/code/dump），退出码 0 成功 / 1 运行错误 / 2 参数错误
- 出身：martin 仓 `scripts/sms/smsctl.sh` bash 原型（2026-10-24 验证 7 会话 3 验证码全对）封装为全局 CLI，语义逐字保持
