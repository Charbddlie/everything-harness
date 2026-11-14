#!/usr/bin/env python3
"""Remote GPU monitor and worker lifecycle."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

ROOT = Path.home() / ".local/share/gpu-holder"
SESSION = "gpu-holder"


def run(args, timeout=15):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or
                           f"{args[0]} exited {result.returncode}")
    return result.stdout


def snapshot():
    root = ET.fromstring(run(["nvidia-smi", "-q", "-x"], timeout=10))
    cards = []
    for index, node in enumerate(root.findall("gpu")):
        card = {"index": index, "uuid": node.findtext("uuid") or f"unknown-{index}",
                "name": node.findtext("product_name") or "unknown", "pids": []}
        try:
            if node.findtext("mig_mode/current_mig") == "Enabled":
                raise ValueError("MIG 已开启，请使用整卡模式")
            for process in node.findall("processes/process_info"):
                card["pids"].append(int(process.findtext("pid")))
            for key, path in (("used_mib", "fb_memory_usage/used"),
                              ("total_mib", "fb_memory_usage/total"),
                              ("utilization", "utilization/gpu_util")):
                card[key] = int(node.findtext(path).split()[0])
            if card["uuid"].startswith("unknown-"):
                raise ValueError("GPU UUID 不可用")
        except (ValueError, TypeError, AttributeError) as exc:
            card["error"] = str(exc)
        cards.append(card)
    if not cards:
        raise RuntimeError("nvidia-smi 未返回 GPU")
    return cards


class Worker:
    def __init__(self, card, config):
        self.log_path = ROOT / f"worker-{card['index']}.log"
        with self.log_path.open("w") as log:
            self.process = subprocess.Popen(
                [os.path.expanduser(config["worker_python"]), str(ROOT / "train.py"),
                 "--uuid", card["uuid"], "--fraction", str(config["memory_fraction"]),
                 "--duty-cycle", str(config["compute_duty_cycle"]),
                 "--parent", str(os.getpid())],
                stdout=subprocess.PIPE, stderr=log, text=True)
        self.pid = self.process.pid
        self.started = time.monotonic()
        self.allocation = None

    def status(self):
        if self.process.poll() is not None:
            output = self.log_path.read_text().strip() or self.process.communicate()[0].strip()
            raise RuntimeError(output or f"占卡进程退出 ({self.process.returncode})")
        if self.allocation is None:
            if select.select([self.process.stdout], [], [], 0)[0]:
                line = self.process.stdout.readline().strip()
                try:
                    self.allocation = json.loads(line)
                except json.JSONDecodeError:
                    raise RuntimeError(line or "占卡进程未返回分配结果") from None
            elif time.monotonic() - self.started > 30:
                raise RuntimeError(f"训练进程初始化超过 30 秒，请查看 {self.log_path}")
        return self.allocation

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()


class Manager:
    def __init__(self, config, worker_factory=Worker):
        self.config = config
        self.worker_factory = worker_factory
        self.workers = {}
        self.idle_since = {}
        self.failures = {}

    def release(self, uuid):
        worker = self.workers.pop(uuid, None)
        if worker:
            worker.stop()

    def close(self):
        for uuid in list(self.workers):
            self.release(uuid)

    def update(self, cards, now=None):
        now = time.monotonic() if now is None else now
        selected = self.config.get("gpus")
        if selected is not None:
            cards = [card for card in cards if card["index"] in selected]
            found = {card["index"] for card in cards}
            cards += [{"index": index, "uuid": f"missing-{index}",
                       "error": "指定的 GPU 不存在"} for index in selected if index not in found]
        active = {card["uuid"] for card in cards}
        for uuid in set(self.workers) - active:
            self.release(uuid)
        result = []
        for original in cards:
            card = dict(original)
            uuid = card["uuid"]
            worker = self.workers.get(uuid)
            external = [pid for pid in card.get("pids", []) if not worker or pid != worker.pid]
            if card.get("error"):
                self.release(uuid)
                self.idle_since.pop(uuid, None)
                card["state"] = "error"
            elif external or (not worker and
                              (card["utilization"] > 0 or
                               card["used_mib"] > self.config["idle_memory_mib"])):
                self.release(uuid)
                self.idle_since.pop(uuid, None)
                self.failures.pop(uuid, None)
                card.update(state="busy", pids=external)
            else:
                try:
                    failure = self.failures.get(uuid)
                    if failure and now < failure[0]:
                        raise RuntimeError(failure[1])
                    if failure:
                        del self.failures[uuid]
                    idle_since = self.idle_since.setdefault(uuid, now)
                    if not worker and now - idle_since >= self.config["idle_seconds"]:
                        worker = self.worker_factory(card, self.config)
                        self.workers[uuid] = worker
                    allocation = worker.status() if worker else None
                    card["state"] = "holding" if allocation else "idle"
                    if allocation:
                        card["allocated_mib"] = allocation["allocated_mib"]
                except Exception as exc:
                    self.release(uuid)
                    self.failures.setdefault(uuid, (now + 30, str(exc)))
                    self.idle_since.pop(uuid, None)
                    card.update(state="error", error=str(exc))
            result.append(card)
        return sorted(result, key=lambda card: card["index"])


def write_status(status):
    status["updated_at"] = time.time()
    temporary = ROOT / "status.tmp"
    temporary.write_text(json.dumps(status, ensure_ascii=False))
    temporary.replace(ROOT / "status.json")


def setup_command(args, stop, message, check=True):
    with (ROOT / "setup.log").open("a") as log:
        log.write("\n" + shlex.join(args) + "\n")
        log.flush()
        process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while process.poll() is None:
                write_status({"gpus": [], "starting": True, "message": message})
                if stop.wait(1):
                    raise InterruptedError("环境配置已停止")
            if check and process.returncode:
                detail = (ROOT / "setup.log").read_text()[-2000:].strip()
                raise RuntimeError(f"{message}失败：{detail}")
            return process.returncode == 0
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def prepare_environment(config, stop):
    python = os.path.expanduser(config["worker_python"])
    if not shutil.which(python):
        path = Path(python)
        if path.parent.name != "bin" or path.name not in ("python", "python3"):
            raise RuntimeError(f"Python 命令不存在：{python}；自动创建环境时请指定 <环境目录>/bin/python")
        environment = path.parent.parent
        if not setup_command([sys.executable, "-m", "venv", str(environment)], stop,
                             "创建 Python 环境", check=False):
            archive = ROOT / "virtualenv.pyz"
            download = ("import urllib.request; urllib.request.urlretrieve("
                        "'https://bootstrap.pypa.io/virtualenv.pyz', " + repr(str(archive)) + ")")
            setup_command([sys.executable, "-c", download], stop, "下载环境工具")
            setup_command([sys.executable, str(archive), str(environment)], stop, "创建 Python 环境")
    probe = "import torch; assert torch.version.cuda, '需要 CUDA 版 PyTorch'"
    if not setup_command([python, "-c", probe], stop, "检查训练环境", check=False):
        setup_command([python, "-m", "pip", "install", "--upgrade", "torch",
                       "--index-url", "https://download.pytorch.org/whl/cu126"],
                      stop, "安装 CUDA PyTorch")
        setup_command([python, "-c", probe], stop, "检查训练环境")
    return python


def daemon():
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / "daemon.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("GPU monitor 已在运行")
        config = json.loads((ROOT / "config.json").read_text())
        manager = Manager(config)
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: stop.set())
        last_cards = []
        environment_ready = False
        try:
            while not stop.is_set():
                try:
                    if not environment_ready:
                        config["worker_python"] = prepare_environment(config, stop)
                        environment_ready = True
                    last_cards = manager.update(snapshot())
                    status = {"gpus": last_cards}
                except InterruptedError:
                    break
                except Exception as exc:
                    manager.close()
                    manager.idle_since.clear()
                    last_cards = [dict(card, state="error", error=str(exc)) for card in last_cards]
                    status = {"gpus": last_cards, "error": str(exc)}
                write_status(status)
                stop.wait(config["poll_interval"] if environment_ready else 30)
        finally:
            manager.close()
            write_status({"gpus": [], "stopped": True})


def session_exists():
    result = subprocess.run(["tmux", "has-session", "-t", "=" + SESSION],
                            capture_output=True, timeout=5)
    return result.returncode == 0


def ensure():
    if not session_exists():
        (ROOT / "status.json").unlink(missing_ok=True)
        command = shlex.join([sys.executable, str(ROOT / "remote.py"), "daemon"])
        command += " >> " + shlex.quote(str(ROOT / "daemon.log")) + " 2>&1"
        run(["tmux", "new-session", "-d", "-s", SESSION, command])
    status_file = ROOT / "status.json"
    if status_file.exists():
        status = json.loads(status_file.read_text())
        config = json.loads((ROOT / "config.json").read_text())
        if status.get("stopped") or time.time() - status["updated_at"] > max(30, config["poll_interval"] * 3):
            raise RuntimeError("远端监控未更新，请查看 " + str(ROOT / "daemon.log"))
    else:
        status = {"gpus": [], "starting": True}
    print(json.dumps(status, ensure_ascii=False))


def stop_remote():
    if session_exists():
        run(["tmux", "kill-session", "-t", "=" + SESSION])
    # Wait until the monitor has released its children and dropped the lock.
    lock_path = ROOT / "daemon.lock"
    if lock_path.exists():
        with lock_path.open("r") as lock:
            deadline = time.monotonic() + 15
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("等待远端释放 GPU 超时")
                    time.sleep(0.1)
    print(json.dumps({"stopped": True}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["ensure", "daemon", "stop"])
    args = parser.parse_args()
    if args.command == "daemon":
        daemon()
    elif args.command == "stop":
        stop_remote()
    else:
        ensure()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
