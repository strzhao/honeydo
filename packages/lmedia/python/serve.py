"""serve.py — 常驻推理 daemon（stdlib-only unix socket，NDJSON 帧）。
 * 由 TS 侧 `lmedia image serve start` 或 gen/edit 自动拉起；路径全部由 argv 传入。
 * 顺序关键：bind+listen **先于** import torch/加载模型——加载期（~2min）客户端连接进
 * backlog 排队，首任务等加载完执行，不回退冷路径。
 * 线程模型：dispatcher（主线程 accept + 每连接轻线程读请求/排队/ping）
 *          + worker（唯一碰 torch 的线程，串行消费任务队列 ← GPU 串行铁律的代码化）
 *          + watchdog（空闲自退）
 * 协议：请求一行 JSON {"kind": "gen|edit|upscale|ping", ...}；
 *       响应 0..n 个 {"t":"queued"|"log"} 帧 + 恰好 1 个 {"t":"done", ok, result|error} 帧后 close。
 * 退出：TERM/idle 统一 unlink socket+status → os._exit(0)（绕过 MPS 退出清理挂死——2026-08 实录坑）。
 * 依赖 gen.py/edit.py/upscale.py 的 load_pipe/run 函数（同目录 import，脚本目录自动在 sys.path）。
"""
import argparse
import contextlib
import gc
import json
import os
import queue
import re
import signal
import socket
import sys
import threading
import time
import traceback

REQUEST_LIMIT = 8 << 20  # 单行请求上限 8MB（正常 payload 10KB 级）
MAX_ADAPTERS = 4         # LoRA adapter 缓存上限（单个几百 MB，防无限累积）

STATE = {
    "pid": os.getpid(), "mode": None, "state": "boot",  # boot|loading|ready|busy
    "busy": False, "queue": 0, "jobs": 0,
    "lastJobAt": None, "startedAt": None, "snapshot": None,
}
JOBS: "queue.Queue[tuple]" = queue.Queue()
EXITING = threading.Event()
SRV: socket.socket | None = None
LOG = None            # logfile 句柄（daemon 自身输出）
SOCK_PATH = STATUS_PATH = None

# —— worker 线程内初始化（延迟 import torch 后才存在）——
PIPE = None           # QwenImagePipeline | QwenImageEditPlusPipeline
SR = None             # (path, spandrel model) upscale 懒加载缓存
GEN_SR = None         # gen 内联超分（upscaleTo）懒加载
LOADED: dict[str, str] = {}   # adapter_name -> abspath
_ADAPTER_SEQ = 0
CUR_LIGHTNING = False
SCHED_DEFAULT_CONFIG = None   # load 后的默认调度器 config（任务间恢复用）


def log(msg: str) -> None:
    if LOG:
        LOG.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")


def write_status() -> None:
    tmp = STATUS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(STATE, f, ensure_ascii=False)
    os.replace(tmp, STATUS_PATH)


def send(conn, frame: dict) -> None:
    """发一帧；对端已死（EPIPE）吞掉——任务照常算完，结果丢弃。"""
    try:
        conn.sendall((json.dumps(frame, ensure_ascii=False) + "\n").encode())
    except OSError:
        pass


class ClientWriter:
    """redirect_stdout/stderr 用：任务输出按 \\n 与 \\r 切帧转发客户端 + 落日志（tqdm 进度条走 \\r）。"""

    def __init__(self, conn):
        self.conn = conn
        self.tail = ""

    def write(self, s: str) -> int:
        self.tail += s
        parts = re.split(r"[\r\n]+", self.tail)
        self.tail = parts.pop()
        for p in parts:
            if p.strip():
                send(self.conn, {"t": "log", "line": p})
                log(f"  | {p}")
        return len(s)

    def flush(self) -> None:
        pass


def readline(conn, limit: int = REQUEST_LIMIT) -> bytes | None:
    buf = b""
    while b"\n" not in buf:
        if len(buf) > limit:
            return None
        try:
            chunk = conn.recv(65536)
        except OSError:
            return None
        if not chunk:
            return None
        buf += chunk
    return buf.split(b"\n", 1)[0]


def status_snapshot() -> dict:
    return {**STATE, "queue": JOBS.qsize(), "kind": "ping"}


def handle_conn(conn) -> None:
    """dispatcher 派生的轻线程：读请求/排队/ping，不碰 torch。"""
    try:
        line = readline(conn)
        if line is None:
            conn.close()
            return
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            send(conn, {"t": "done", "ok": False, "error": "请求不是合法 JSON"})
            conn.close()
            return
        kind = req.get("kind")
        if kind == "ping":
            send(conn, {"t": "done", "ok": True, "result": status_snapshot()})
            conn.close()
            return
        if kind not in ("gen", "edit", "upscale"):
            send(conn, {"t": "done", "ok": False, "error": f"未知 kind: {kind}"})
            conn.close()
            return
        send(conn, {"t": "queued", "position": JOBS.qsize() + 1})
        JOBS.put((conn, req))
    except Exception:
        traceback.print_exc(file=LOG)
        try:
            conn.close()
        except OSError:
            pass


def apply_loras(pipe, loras: list | None) -> None:
    """LoRA 热切换（gen/edit 通用）。peft 后端下 adapter 是旁路模块、base 权重不被改写，
    set_adapters 只切激活集与 scale（毫秒级）；未加载过的文件在常驻 pipe 上直接 load。"""
    global _ADAPTER_SEQ
    import torch

    req = [(os.path.abspath(l["path"]), float(l.get("scale", 1.0))) for l in (loras or [])]
    if not req:
        if LOADED:
            pipe.disable_lora()  # 不用 set_adapters([])：空列表语义跨版本不稳
        return
    by_path = {p: n for n, p in LOADED.items()}
    missing = [p for p, _ in req if p not in by_path]
    if missing and len(LOADED) + len(missing) > MAX_ADAPTERS:
        pipe.unload_lora_weights()
        LOADED.clear()
        gc.collect()
        torch.mps.empty_cache()
        by_path = {}
        missing = [p for p, _ in req]
    for p in missing:
        _ADAPTER_SEQ += 1
        name = f"a{_ADAPTER_SEQ}"
        pipe.load_lora_weights(p, adapter_name=name)
        LOADED[name] = p
        by_path[p] = name
        log(f"lora loaded: {name} <- {p}")
    pipe.enable_lora()
    pipe.set_adapters([by_path[p] for p, _ in req], [s for _, s in req])


def apply_scheduler(pipe, lightning: bool) -> None:
    """Lightning 蒸馏调度器 per-job 切换/恢复（配置常量 import 自 gen.py——与 edit.py 内
    同名定义逐字段一致，改调度参数时两处需同步）。"""
    global CUR_LIGHTNING
    if lightning == CUR_LIGHTNING:
        return
    from diffusers import FlowMatchEulerDiscreteScheduler
    import gen as G

    pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(
        G.LIGHTNING_SCHEDULER_CONFIG if lightning else SCHED_DEFAULT_CONFIG
    )
    CUR_LIGHTNING = lightning


def run_job(req: dict) -> dict:
    kind = req["kind"]
    if kind == "gen":
        import gen as G
        global GEN_SR
        apply_loras(PIPE, req.get("loras"))
        apply_scheduler(PIPE, bool(req.get("lightningSched")))
        if req.get("upscaleTo") and GEN_SR is None:
            GEN_SR = G.load_esrgan(req.get("esrganModel"))
        return G.run(PIPE, req, sr=GEN_SR)
    if kind == "edit":
        import edit as E
        apply_loras(PIPE, req.get("loras"))
        apply_scheduler(PIPE, bool(req.get("lightningSched")))
        return E.run(PIPE, req)
    if kind == "upscale":
        import upscale as U
        global SR
        path = req.get("model") or "/tmp/RealESRGAN_x2.pth"
        if SR is None or SR[0] != path:
            SR = (path, U.load_model(path))
        return U.run(SR[1], req)
    raise ValueError(f"未知 kind: {kind}")


def worker(mode: str, snapshot: str) -> None:
    """唯一碰 torch 的线程：加载模型 → 串行消费任务队列。"""
    global PIPE, SCHED_DEFAULT_CONFIG, STATE
    import torch  # —— 重 import 从这里才开始（bind 已完成，客户端在 backlog 排队）——

    STATE["state"] = "loading"
    write_status()
    log(f"loading pipeline mode={mode} snapshot={snapshot}")
    t0 = time.time()
    if mode == "gen":
        import gen as G
        PIPE = G.load_pipe(snapshot)
    else:
        import edit as E
        PIPE = E.load_pipe(snapshot)
    SCHED_DEFAULT_CONFIG = dict(PIPE.scheduler.config)
    STATE.update(state="ready", startedAt=time.time(), lastJobAt=time.time())
    write_status()
    log(f"ready（加载 {time.time() - t0:.1f}s）")

    while True:
        conn, req = JOBS.get()
        STATE.update(busy=True, state="busy", queue=JOBS.qsize())
        write_status()
        log(f"job #{STATE['jobs'] + 1} kind={req['kind']} out={req.get('out') or req.get('in')}")
        t0 = time.time()
        try:
            with contextlib.redirect_stdout(ClientWriter(conn)), contextlib.redirect_stderr(
                ClientWriter(conn)
            ):
                result = run_job(req)
            send(conn, {"t": "done", "ok": True, "result": result})
            log(f"job done in {time.time() - t0:.1f}s")
        except Exception as e:
            tb = traceback.format_exc()[-2000:]
            log(f"job FAILED in {time.time() - t0:.1f}s: {e}\n{tb}")
            send(conn, {"t": "done", "ok": False, "error": str(e), "tb": tb})
        finally:
            try:
                conn.close()
            except OSError:
                pass
            STATE.update(busy=False, state="ready", jobs=STATE["jobs"] + 1, lastJobAt=time.time())
            write_status()
            gc.collect()
            torch.mps.empty_cache()  # 保权重，释放激活/allocator 缓存块


def shutdown_and_exit() -> None:
    """统一退出路径。unlink 先行——dispatcher 主线程在 EXITING.set() 后即退出 main 并冻结
    本 daemon 线程，清理动作若排在 sleep 后会被竞态跳过（2026-08-30 实录：idle 自退残留 socket）。
    unlink 后新 connect 得 ENOENT → 客户端冷路径，行为等价于关 listen。"""
    EXITING.set()
    for p in (SOCK_PATH, STATUS_PATH):
        try:
            os.unlink(p)
        except OSError:
            pass
    if SRV:
        try:
            SRV.close()
        except OSError:
            pass
    time.sleep(0.3)  # 让 in-flight 客户端收到断连（而非挂到进程树消亡）
    log("exit")
    os._exit(0)


def watchdog(idle_timeout: float) -> None:
    """空闲自退（默认 30min）：ready 且队列空且距上一任务超时。"""
    while not EXITING.wait(15):
        if STATE["busy"] or not JOBS.empty() or STATE["lastJobAt"] is None:
            continue
        idle = time.time() - STATE["lastJobAt"]
        if idle > idle_timeout:
            log(f"idle {idle:.0f}s > {idle_timeout:.0f}s，自退")
            shutdown_and_exit()


def on_term(signum, frame) -> None:
    log(f"signal {signum}")
    shutdown_and_exit()


def bind_with_stale_probe(path: str) -> socket.socket:
    """socket 文件已存在：probe connect 通=已有活实例（exit 3）；拒=陈旧残留（-9 遗物）清掉重绑。"""
    if os.path.exists(path):
        probe = socket.socket(socket.AF_UNIX)
        try:
            probe.connect(path)
            probe.close()
            print(f"已有一个 {path} 的活实例在运行", file=sys.stderr)
            sys.exit(3)
        except OSError:
            os.unlink(path)
    s = socket.socket(socket.AF_UNIX)
    s.bind(path)
    return s


def main() -> None:
    global LOG, SRV, SOCK_PATH, STATUS_PATH, STATE
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["gen", "edit"], required=True)
    ap.add_argument("--socket", required=True)
    ap.add_argument("--status", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--idle-timeout", type=float, default=1800)
    a = ap.parse_args()

    os.makedirs(os.path.dirname(a.socket), exist_ok=True)
    LOG = open(a.log, "a", buffering=1)
    sys.stdout = sys.stderr = LOG  # daemon 自身输出全落日志（任务输出由 ClientWriter 定向）
    SOCK_PATH, STATUS_PATH = a.socket, a.status
    STATE.update(mode=a.mode, startedAt=time.time(), snapshot=a.snapshot)
    write_status()
    log(f"boot pid={os.getpid()} mode={a.mode} idle_timeout={a.idle_timeout}s")

    srv = bind_with_stale_probe(a.socket)
    srv.listen(128)
    SRV = srv
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    threading.Thread(target=worker, args=(a.mode, a.snapshot), daemon=True).start()
    threading.Thread(target=watchdog, args=(a.idle_timeout,), daemon=True).start()

    while not EXITING.is_set():  # 主线程 = dispatcher
        try:
            conn, _ = srv.accept()
        except OSError:
            break
        threading.Thread(target=handle_conn, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
