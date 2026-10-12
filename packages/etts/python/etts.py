"""etts python driver — node 壳 spawn 此脚本，JSON payload 走 argv[1]，结果 JSON 走 stdout 末行。

协议（与 node 侧 run-python.ts / 契约规约 1:1）：
  {"op": "synth", "items": [{"text","voice","out"}], "retry": 3, "proxy": "...?"}
    → {"results": [{"ok": true, "out": "...", "attempts": 1}
                  | {"ok": false, "out": "...", "error": "...", "attempts": n}]}
  {"op": "voices", "lang": "...?"}
    → {"voices": [{"shortName", "gender", "locale"}]}

- 代理优先级：payload.proxy（--proxy flag）> ETTS_PROXY > HTTPS_PROXY，显式传给
  edge_tts（aiohttp 不保证消费环境变量，必须显式透传才算被消费）。
- synth 逐条重试（每条 1..retry 次尝试，指数退避），进度/重试标记走 stderr；
  失败条目清理残留产物（edge-tts 失败时可能留下 0 字节文件，契约要求失败行无残留）。
- 整体崩溃（edge_tts 未安装 / voices API 不可达）→ 异常透传、非零退出，
  由 node 侧统一转 exit 1。
"""
import asyncio
import json
import os
import sys

import edge_tts


def resolve_proxy(payload: dict) -> str | None:
    return (
        payload.get("proxy")
        or os.environ.get("ETTS_PROXY")
        or os.environ.get("HTTPS_PROXY")
        or None
    )


def stderr(msg: str) -> None:
    sys.stderr.write(f"etts: {msg}\n")
    sys.stderr.flush()


def drop_partial(out: str) -> None:
    """失败条目不留残留产物（0 字节/半截文件都算残留）。"""
    try:
        if os.path.exists(out):
            os.unlink(out)
    except OSError as e:
        stderr(f"warn: cannot remove partial output {out}: {e}")


async def synth_one(text: str, voice: str, out: str, retry: int, proxy: str | None) -> dict:
    last_err = ""
    for attempt in range(1, retry + 1):
        try:
            # 每次尝试新建 Communicate（流式状态不可复用）
            comm = edge_tts.Communicate(text, voice, proxy=proxy)
            await comm.save(out)
            return {"ok": True, "out": out, "attempts": attempt}
        except Exception as e:  # noqa: BLE001 — 错误串原样透传给失败清单
            last_err = str(e)
            drop_partial(out)
            stderr(f"attempt {attempt}/{retry} failed for {out}: {last_err}")
            if attempt < retry:
                await asyncio.sleep(min(2 ** (attempt - 1), 5))
    return {"ok": False, "out": out, "error": last_err, "attempts": retry}


async def op_synth(payload: dict) -> dict:
    retry = int(payload.get("retry", 3))
    proxy = resolve_proxy(payload)
    results = []
    for item in payload.get("items", []):
        r = await synth_one(item["text"], item["voice"], item["out"], retry, proxy)
        results.append(r)
    return {"results": results}


async def op_voices(payload: dict) -> dict:
    proxy = resolve_proxy(payload)
    voices = await edge_tts.list_voices(proxy=proxy)
    lang = payload.get("lang")
    out = [
        {"shortName": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]}
        for v in voices
        if not lang or v["Locale"].startswith(lang)
    ]
    return {"voices": out}


async def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: etts.py '<json payload>' (piped from node shell)")
    payload = json.loads(sys.argv[1])
    op = payload.get("op")
    if op == "synth":
        result = await op_synth(payload)
    elif op == "voices":
        result = await op_voices(payload)
    else:
        sys.exit(f"unknown op: {op!r}")
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
