#!/usr/bin/env python3
"""Local tmux service and SSH dashboard."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time

BASE = Path(__file__).resolve().parent
SESSION = "gpu-holder"
REMOTE = ".local/share/gpu-holder/remote.py"
DEFAULTS = {"memory_fraction": 0.8, "poll_interval": 2, "refresh_interval": 3,
            "idle_seconds": 10, "idle_memory_mib": 512, "ssh_timeout": 10,
            "compute_duty_cycle": 0.1}


def load_config(path):
    config = {"worker_python": "~/.local/share/gpu-holder/venv/bin/python", **DEFAULTS, **json.loads(path.read_text())}
    for key in DEFAULTS:
        value = config[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{key} 必须是有限数字")
        if value < 0 or (key not in ("idle_seconds", "idle_memory_mib", "compute_duty_cycle") and value == 0):
            raise ValueError(f"{key} 数值不合法")
    if config["memory_fraction"] >= 1:
        raise ValueError("memory_fraction 必须大于 0 且小于 1")
    if not isinstance(config.get("servers"), list) or not config["servers"]:
        raise ValueError(f"请先在 {path} 的 servers 中填写 SSH 主机名")
    if config["compute_duty_cycle"] > 1:
        raise ValueError("compute_duty_cycle 必须在 0 到 1 之间")
    servers = []
    for item in config["servers"]:
        server = {"host": item} if isinstance(item, str) else dict(item)
        host = server.get("host")
        if not isinstance(host, str) or not host or host.startswith("-") or any(c.isspace() for c in host):
            raise ValueError("server.host 必须是 SSH 主机名或别名")
        gpus = server.get("gpus")
        if gpus is not None and (not isinstance(gpus, list) or not gpus or
                                 any(type(i) is not int or i < 0 for i in gpus) or
                                 len(set(gpus)) != len(gpus)):
            raise ValueError(f"{host}: gpus 必须是非空、不重复的 GPU 索引列表")
        server["worker_python"] = server.get("worker_python", config["worker_python"])
        python = server["worker_python"]
        if not isinstance(python, str) or not python.strip() or "\0" in python:
            raise ValueError(f"{host}: worker_python 必须是远端 Python 路径或命令名")
        servers.append(server)
    if len({s["host"] for s in servers}) != len(servers):
        raise ValueError("servers 中有重复主机")
    config["servers"] = servers
    return config


def ssh(host, config, command, source=None):
    timeout = config["ssh_timeout"]
    args = ["ssh", "-T", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={math.ceil(timeout)}",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", host, command]
    result = subprocess.run(args, input=source, text=True, capture_output=True, timeout=timeout + 25)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or
                           f"ssh exited {result.returncode}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("远端输出不是 JSON: " + result.stdout.strip()[:300]) from None


def deploy(server, config):
    remote_config = {key: config[key] for key in
                     ("memory_fraction", "poll_interval", "idle_seconds", "idle_memory_mib", "compute_duty_cycle")}
    remote_config["worker_python"] = server["worker_python"]
    if "gpus" in server:
        remote_config["gpus"] = server["gpus"]
    files = {name: (BASE / name).read_text() for name in ("remote.py", "train.py")}
    files["config.json"] = json.dumps(remote_config)
    source = (
        "import pathlib, subprocess, sys\n"
        "root = pathlib.Path.home() / '.local/share/gpu-holder'\n"
        "root.mkdir(parents=True, exist_ok=True)\n"
        f"files = {files!r}\n"
        "changed = any(not (root / name).exists() or (root / name).read_text() != data "
        "for name, data in files.items())\n"
        "if changed and (root / 'remote.py').exists():\n"
        "    subprocess.run([sys.executable, str(root / 'remote.py'), 'stop'], "
        "check=True, stdout=subprocess.DEVNULL)\n"
        "for name, data in files.items():\n"
        "    path = root / name\n"
        "    temporary = root / (name + '.tmp')\n"
        "    temporary.write_text(data)\n"
        "    temporary.replace(path)\n"
        "subprocess.run([sys.executable, str(root / 'remote.py'), 'ensure'], check=True)\n"
    )
    return ssh(server["host"], config, "python3 -", source)


def render(config, states):
    lines = ["GPU Holder  " + datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             "占卡=本程序持有显存  正常=其他进程/资源使用  空闲=等待占卡",
             "", f"{'SERVER':<28} {'占卡':>5} {'正常':>5} {'问题':>5} {'空闲':>5}  状态"]
    details = []
    for server in config["servers"]:
        host = server["host"]
        status = states.get(host, {"gpus": [], "starting": True})
        cards = status.get("gpus", [])
        if status.get("error"):
            counts = ["0", "0", str(len(cards)) if cards else "?", "0"]
            label = "错误"
            details.append(f"{host}: {status['error']}")
        else:
            counts = [str(sum(c["state"] == state for c in cards))
                      for state in ("holding", "busy", "error", "idle")]
            label = status.get("message") or ("启动中" if status.get("starting") else "在线")
        lines.append(f"{host:<28} " + " ".join(f"{n:>7}" for n in counts) + "  " + label)
        for card in cards:
            if card.get("error"):
                details.append(f"{host} GPU {card['index']}: {card['error']}")
    if details:
        lines += ["", *details]
    lines += ["", "tmux 分离：Ctrl-b d    停止并释放：python3 gpu_holder.py stop"]
    return "\n".join(lines)


def monitor(config):
    states = {}
    lock = threading.Lock()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: stop.set())

    def watch(server):
        deployed = False
        host = server["host"]
        while not stop.is_set():
            try:
                status = (ssh(host, config, f"python3 {REMOTE} ensure") if deployed
                          else deploy(server, config))
                deployed = True
            except Exception as exc:
                deployed = False
                with lock:
                    previous = states.get(host, {}).get("gpus", [])
                status = {"gpus": [dict(card, state="error") for card in previous], "error": str(exc)}
            with lock:
                states[host] = status
            stop.wait(config["refresh_interval"])

    with ThreadPoolExecutor(max_workers=len(config["servers"])) as pool:
        for server in config["servers"]:
            pool.submit(watch, server)
        try:
            while not stop.is_set():
                with lock:
                    display = render(config, states)
                print(("\033[2J\033[H" if sys.stdout.isatty() else "") + display, flush=True)
                stop.wait(1)
        finally:
            stop.set()


def tmux_exists():
    return subprocess.run(["tmux", "has-session", "-t", "=" + SESSION],
                          capture_output=True).returncode == 0


def start(config_path):
    if tmux_exists():
        print(f"本地会话已存在：tmux attach -t {SESSION}")
        return
    command = shlex.join([sys.executable, str(BASE / "gpu_holder.py"), "run",
                          "--config", str(config_path)])
    subprocess.run(["tmux", "new-session", "-d", "-s", SESSION, "-c", str(BASE), command], check=True)
    print(f"已启动：tmux attach -t {SESSION}")


def stop_all(config):
    # Stop local retries before terminating remote sessions.
    if tmux_exists():
        subprocess.run(["tmux", "kill-session", "-t", "=" + SESSION], check=True)
        deadline = time.monotonic() + config["ssh_timeout"] + 30
        lock_path = BASE / ".monitor.lock"
        import fcntl
        if lock_path.exists():
            with lock_path.open("r") as lock:
                while True:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("本地监控仍在处理 SSH，请稍后重试 stop")
                        time.sleep(0.1)
    def stop_server(server):
        host = server["host"]
        command = f"if test -f {REMOTE}; then python3 {REMOTE} stop; else printf '{{\"stopped\":true}}'; fi"
        try:
            ssh(host, config, command)
            return host, None
        except Exception as exc:
            return host, str(exc)
    with ThreadPoolExecutor(max_workers=len(config["servers"])) as pool:
        results = list(pool.map(stop_server, config["servers"]))
    for host, error in results:
        print(f"{host}: " + (f"停止失败：{error}" if error else "已停止并释放"))
    return int(any(error for _, error in results))


def main():
    parser = argparse.ArgumentParser(description="在远程空闲 NVIDIA GPU 上自动占用显存")
    parser.add_argument("command", nargs="?", default="start", choices=["start", "run", "status", "stop"])
    parser.add_argument("--config", type=Path, default=BASE / "config.json")
    args = parser.parse_args()
    config_path = args.config.resolve()
    config = load_config(config_path)
    if args.command == "start":
        start(config_path)
    elif args.command == "run":
        import fcntl
        with (BASE / ".monitor.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            monitor(config)
    elif args.command == "stop":
        return stop_all(config)
    else:
        states = {}
        def fetch(server):
            try:
                command = f"cat .local/share/gpu-holder/status.json"
                result = ssh(server["host"], config, command)
                if result.get("stopped") or time.time() - result["updated_at"] > max(30, config["poll_interval"] * 3):
                    raise RuntimeError("远端监控已停止或状态过期")
                return server["host"], result
            except Exception as exc:
                return server["host"], {"error": str(exc), "gpus": []}
        with ThreadPoolExecutor(max_workers=len(config["servers"])) as pool:
            states.update(pool.map(fetch, config["servers"]))
        print(render(config, states))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        sys.exit(1)
