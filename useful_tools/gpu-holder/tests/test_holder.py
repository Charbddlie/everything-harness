import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import gpu_holder as local
import remote
import train

CONFIG = {**local.DEFAULTS, "idle_seconds": 2}
XML = """<nvidia_smi_log><gpu id="00000000:01:00.0">
<product_name>Test GPU</product_name><uuid>GPU-test</uuid>
<fb_memory_usage><total>80000 MiB</total><used>0 MiB</used></fb_memory_usage>
<utilization><gpu_util>0 %</gpu_util></utilization>
<processes>{processes}</processes></gpu></nvidia_smi_log>"""


def card(index=0, pids=None, **extra):
    return {"index": index, "uuid": f"GPU-{index}", "pids": pids or [],
            "used_mib": 0, "total_mib": 80000, "utilization": 0, **extra}


class FakeWorker:
    instances = []

    def __init__(self, card, config):
        self.pid = 100 + card["index"]
        self.stopped = False
        self.error = None
        self.instances.append(self)

    def status(self):
        if self.error:
            raise RuntimeError(self.error)
        return {"allocated_mib": 64000}

    def stop(self):
        self.stopped = True


class LifecycleTests(unittest.TestCase):
    def test_idle_hold_yield_reacquire_and_release(self):
        FakeWorker.instances = []
        manager = remote.Manager(CONFIG, FakeWorker)
        self.assertEqual(manager.update([card()], now=0)[0]["state"], "idle")
        self.assertEqual(manager.update([card()], now=2)[0]["state"], "holding")
        worker = manager.workers["GPU-0"]
        self.assertEqual(manager.update([card(pids=[worker.pid], used_mib=64000)], now=3)[0]["state"], "holding")
        status = manager.update([card(pids=[worker.pid, 999], used_mib=65000)], now=4)
        self.assertEqual(status[0]["state"], "busy")
        self.assertTrue(worker.stopped)
        self.assertFalse(manager.workers)
        self.assertEqual(manager.update([card(pids=[999])], now=5)[0]["state"], "busy")
        self.assertEqual(manager.update([card()], now=6)[0]["state"], "idle")
        self.assertEqual(manager.update([card()], now=8)[0]["state"], "holding")
        manager.close()
        self.assertTrue(all(w.stopped for w in FakeWorker.instances))

    def test_errors_selection_and_busy_without_visible_pid(self):
        manager = remote.Manager({**CONFIG, "gpus": [0, 2]}, FakeWorker)
        rows = manager.update([card(), card(1)], now=0)
        self.assertEqual([(r["index"], r["state"]) for r in rows], [(0, "idle"), (2, "error")])
        manager.update([card()], now=2)
        worker = manager.workers["GPU-0"]
        worker.error = "CUDA allocation failed"
        self.assertEqual(manager.update([card()], now=3)[0]["state"], "error")
        self.assertTrue(worker.stopped)
        self.assertEqual(manager.update([card()], now=32)[0]["state"], "error")
        self.assertEqual(manager.update([card()], now=33)[0]["state"], "idle")
        self.assertEqual(manager.update([card()], now=35)[0]["state"], "holding")
        manager.update([card(error="GPU lost")], now=36)
        self.assertFalse(manager.workers)
        self.assertEqual(manager.update([card(utilization=10)], now=37)[0]["state"], "busy")
        self.assertEqual(manager.update([card(used_mib=1000)], now=38)[0]["state"], "busy")
        manager.close()

    def test_nvidia_xml_includes_graphics_and_reports_broken_cards(self):
        process = "<process_info><pid>42</pid><type>G</type></process_info>"
        with patch.object(remote, "run", return_value=XML.format(processes=process)):
            self.assertEqual(remote.snapshot()[0]["pids"], [42])
        with patch.object(remote, "run", return_value=XML.format(processes="").replace("0 %", "N/A")):
            self.assertIn("error", remote.snapshot()[0])
        with patch.object(remote, "run", return_value="<nvidia_smi_log/>"):
            with self.assertRaises(RuntimeError):
                remote.snapshot()

    def test_training_scheduler_reservation_and_cleanup(self):
        class Clock:
            now = 0
            def time(self):
                return self.now
        clock = Clock()
        steps, allocations, cleaned = [], [], []
        class Workload:
            def __init__(self, torch):
                pass
            def step(self):
                steps.append(clock.now)
                clock.now += 0.02
        class Stop:
            def is_set(self):
                return clock.now >= 2.1
            def wait(self, duration):
                clock.now += duration
        torch = SimpleNamespace(
            uint8="uint8",
            empty=lambda size, **kwargs: allocations.append(size),
            cuda=SimpleNamespace(is_available=lambda: True, set_device=lambda index: None,
                                 mem_get_info=lambda: (1000, 2000), memory_reserved=lambda: 100,
                                 empty_cache=lambda: cleaned.append(True)))
        with patch.object(train, "TrainingWorkload", Workload), \
             patch.object(train.time, "monotonic", clock.time), \
             patch.object(train.os, "getppid", return_value=123), \
             patch("sys.stdout", new_callable=io.StringIO) as output:
            train.hold_gpu(torch, 0.8, 0.1, 123, Stop())
        self.assertEqual(allocations, [700])
        self.assertTrue(cleaned)
        self.assertGreater(len(steps), 5)
        self.assertLess(len(steps), 25)
        self.assertIn("allocated_mib", json.loads(output.getvalue()))
        clock.now = 0
        steps.clear()
        with patch.object(train.time, "monotonic", clock.time), \
             patch.object(train.os, "getppid", return_value=123), \
             patch("sys.stdout", new_callable=io.StringIO):
            train.hold_gpu(torch, 0.8, 0, 123, Stop())
        self.assertFalse(steps)

    def test_worker_executable_entry_logs_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = root / "train.py"
            entry.write_text("import json,sys,time\n"
                             "print('training warning', file=sys.stderr, flush=True)\n"
                             "print(json.dumps({'allocated_mib': 64}), flush=True)\n"
                             "time.sleep(30)\n")
            config = {**CONFIG, "worker_python": sys.executable}
            with patch.object(remote, "ROOT", root):
                worker = remote.Worker(card(), config)
                try:
                    deadline = time.monotonic() + 5
                    status = None
                    while status is None and time.monotonic() < deadline:
                        status = worker.status()
                        time.sleep(0.01)
                    self.assertEqual(status, {"allocated_mib": 64})
                    cmdline = Path(f"/proc/{worker.pid}/cmdline").read_bytes().split(b"\0")
                    self.assertEqual(cmdline[:2], [os.fsencode(sys.executable), os.fsencode(entry)])
                    self.assertIn("training warning", worker.log_path.read_text())
                    mode_index = cmdline.index(b"--mode")
                    self.assertEqual(cmdline[mode_index + 1], b"normal")
                finally:
                    worker.stop()
                self.assertIsNotNone(worker.process.poll())

    def test_environment_creation_installation_and_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = str(root / "venv/bin/python")
            with patch.object(remote, "ROOT", root), patch.object(remote.shutil, "which", return_value=None), \
                 patch.object(remote, "setup_command", side_effect=[False, True, True, False, True, True, False, True]) as setup:
                self.assertEqual(remote.prepare_environment({"worker_python": python}, threading.Event()), python)
                commands = [call.args[0] for call in setup.call_args_list]
                self.assertIn("venv", commands[0])
                self.assertTrue(any("virtualenv.pyz" in arg for arg in commands[2]))
                self.assertEqual(commands[4][:4], [python, "-m", "pip", "install"])
                self.assertEqual(commands[-1][-1], "setproctitle==1.3.7")
            stop = threading.Event()
            stop.set()
            with patch.object(remote, "ROOT", root):
                with self.assertRaises(InterruptedError):
                    remote.setup_command([sys.executable, "-c", "import time; time.sleep(30)"], stop, "test setup")
                self.assertEqual(json.loads((root / "status.json").read_text())["message"], "test setup")

    def test_modes_config_deploy_and_worker_title(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"servers": ["node-a", {"host": "node-b", "gpus": [0, 1]}]}))
            config, selected = local.set_mode(path, "real", "node-b", [1])
            self.assertEqual(len(selected), 1)
            manager = remote.Manager({**CONFIG, **selected[0]}, FakeWorker)
            rows = manager.update([card(), card(1)], now=0)
            self.assertEqual([r["mode"] for r in rows], ["normal", "real"])
            with patch.object(local, "ssh", return_value={}) as ssh:
                local.deploy(selected[0], config)
                self.assertIn('"gpu_modes": {"1": "real"}', ssh.call_args.args[3])
            before = path.read_text()
            for host, gpus in (("missing", None), (None, [0]), ("node-b", [2])):
                with self.assertRaises(ValueError):
                    local.set_mode(path, "real", host, gpus)
                self.assertEqual(path.read_text(), before)
            config, _ = local.set_mode(path, "normal")
            self.assertTrue(all(s["mode"] == "normal" and not s["gpu_modes"] for s in config["servers"]))
            config, _ = local.set_mode(path, "real", "node-a")
            self.assertEqual(local.load_config(path)["servers"][0]["mode"], "real")
        title = SimpleNamespace(setproctitle=lambda value: titles.append(value))
        torch = SimpleNamespace(set_num_threads=lambda count: None)
        for mode, expected in (("normal", "gpuholder.py"), ("real", "training.py")):
            titles = []
            with patch.dict(sys.modules, {"setproctitle": title, "torch": torch}), \
                 patch.dict(os.environ), patch.object(train.signal, "signal"), \
                 patch.object(train, "hold_gpu") as hold, \
                 patch.object(sys, "argv", ["train.py", "--mode", mode, "--uuid", "GPU-0",
                                           "--fraction", "0.8", "--duty-cycle", "0.1", "--parent", "1"]):
                train.main()
                self.assertEqual(titles, [expected])
                self.assertEqual(hold.call_args.args[1:4], (0.8, 0.1, 1))

    def test_config_and_dashboard(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"servers": ["node-a", {"host": "node-b", "gpus": [0]}]}))
            config = local.load_config(path)
            states = {"node-a": {"gpus": [dict(card(i), state=state) for i, state in
                      enumerate(("holding", "busy", "error", "idle"))]},
                      "node-b": {"gpus": [], "error": "ssh: connection refused"}}
            display = local.render(config, states)
            self.assertIn("node-a", display)
            self.assertIn("connection refused", display)
            self.assertIn("?", display)
            self.assertEqual(config["servers"][0]["worker_python"], "~/.local/share/gpu-holder/venv/bin/python")
            path.write_text(json.dumps({"servers": ["node"], "compute_duty_cycle": 1.5}))
            with self.assertRaises(ValueError):
                local.load_config(path)
            path.write_text(json.dumps({"servers": ["node"], "memory_fraction": 1}))
            with self.assertRaises(ValueError):
                local.load_config(path)


@unittest.skipUnless(shutil.which("tmux"), "requires tmux")
class TmuxIntegrationTests(unittest.TestCase):
    def test_deploy_dashboard_restart_and_stop_with_fake_ssh_and_gpu(self):
        # Real local/remote tmux sessions; SSH and GPU enumeration use fixtures.
        with tempfile.TemporaryDirectory(prefix="gpu-holder-test-") as directory:
            root = Path(directory)
            project = root / "project"
            project.mkdir()
            for name in ("gpu_holder.py", "remote.py", "train.py"):
                shutil.copy(local.BASE / name, project / name)
            bindir = root / "bin"
            bindir.mkdir()
            for name in ("local", "remote-a"):
                (root / name).mkdir()
            socket_prefix = root.name
            tmux = shutil.which("tmux")
            def script(name, content):
                target = bindir / name
                target.write_text("#!" + sys.executable + "\n" + content)
                target.chmod(0o755)
            script("tmux", "import os, pathlib, sys\n"
                   f"os.execv({tmux!r}, [{tmux!r}, '-L', {socket_prefix!r} + '-' + pathlib.Path.home().name, "
                   "'-f', '/dev/null', *sys.argv[1:]])\n")
            script("ssh", "import os, sys\n"
                   "if sys.argv[-2] == 'unreachable':\n"
                   "    print('ssh: connection refused', file=sys.stderr)\n"
                   "    sys.exit(255)\n"
                   f"os.environ['HOME'] = {str(root / 'remote-a')!r}\n"
                   "os.chdir(os.environ['HOME'])\n"
                   "os.execv('/bin/sh', ['sh', '-c', sys.argv[-1]])\n")
            gpu_xml = root / "gpu.xml"
            gpu_xml.write_text(XML.format(processes=""))
            script("nvidia-smi", f"from pathlib import Path\nprint(Path({str(gpu_xml)!r}).read_text())\n")
            config_path = root / "config.json"
            config_path.write_text(json.dumps({"servers": [{"host": "remote-a", "worker_python": sys.executable}, "unreachable"], "idle_seconds": 100,
                                              "poll_interval": 0.1, "refresh_interval": 0.1}))
            (bindir / "setproctitle.py").write_text("def setproctitle(value): pass\n")
            (bindir / "torch.py").write_text("from types import SimpleNamespace\nversion = SimpleNamespace(cuda='12.6')\n")
            env = {**os.environ, "HOME": str(root / "local"), "PYTHONPATH": str(bindir),
                   "PATH": str(bindir) + os.pathsep + os.environ["PATH"]}
            status_path = root / "remote-a/.local/share/gpu-holder/status.json"
            def command(action):
                return subprocess.run([sys.executable, str(project / "gpu_holder.py"),
                                       action, "--config", str(config_path)],
                                      env=env, text=True, capture_output=True, timeout=40)
            def wait_state(state):
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if status_path.exists():
                        value = json.loads(status_path.read_text())
                        if value.get("gpus") and value["gpus"][0]["state"] == state:
                            return value
                    time.sleep(0.1)
                self.fail(f"Timed out waiting for {state}")
            try:
                result = command("start")
                self.assertEqual(result.returncode, 0, result.stderr)
                wait_state("idle")
                result = command("status")
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("在线", result.stdout)
                self.assertIn("unreachable", result.stdout)
                self.assertIn("connection refused", result.stdout)
                local.set_mode(config_path, "real", "remote-a", [0])
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    current = wait_state("idle")
                    if current["gpus"][0].get("mode") == "real":
                        break
                    time.sleep(0.1)
                self.assertEqual(current["gpus"][0]["mode"], "real")
                result = subprocess.run([sys.executable, str(project / "gpu_holder.py"), "status",
                                         "--json", "--config", str(config_path)], env=env,
                                        text=True, capture_output=True, timeout=40)
                self.assertEqual(json.loads(result.stdout)["remote-a"]["gpus"][0]["mode"], "real")
                process = "<process_info><pid>999</pid><type>C</type></process_info>"
                gpu_xml.write_text(XML.format(processes=process))
                wait_state("busy")
                gpu_xml.write_text(XML.format(processes=""))
                wait_state("idle")
                subprocess.run([tmux, "-L", socket_prefix + "-remote-a", "kill-session",
                                "-t", "=gpu-holder"], check=True, capture_output=True)
                time.sleep(0.4)
                wait_state("idle")
                result = command("stop")
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                self.assertIn("remote-a: 已停止并释放", result.stdout)
                self.assertIn("unreachable: 停止失败", result.stdout)
                self.assertTrue(json.loads(status_path.read_text())["stopped"])
                for name in ("local", "remote-a"):
                    check = subprocess.run([tmux, "-L", socket_prefix + "-" + name,
                                            "has-session", "-t", "=gpu-holder"], capture_output=True)
                    self.assertNotEqual(check.returncode, 0)
            finally:
                for name in ("local", "remote-a"):
                    subprocess.run([tmux, "-L", socket_prefix + "-" + name, "kill-server"],
                                   capture_output=True)


if __name__ == "__main__":
    unittest.main()
