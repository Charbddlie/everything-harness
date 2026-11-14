#!/usr/bin/env python3
"""CUDA memory reservation with a small, duty-cycled training workload."""
import argparse
import json
import os
import signal
import sys
import threading
import time


class TrainingWorkload:
    def __init__(self, torch):
        self.torch = torch
        self.inputs = torch.randn(256, 1024, device="cuda")
        self.targets = torch.randn(256, 1024, device="cuda")
        self.weights = torch.randn(1024, 1024, device="cuda", requires_grad=True)

    def step(self):
        loss = (self.inputs @ self.weights - self.targets).square().mean()
        loss.backward()
        with self.torch.no_grad():
            self.weights.add_(self.weights.grad, alpha=-0.01)
        self.weights.grad = None
        self.torch.cuda.synchronize()


def hold_gpu(torch, fraction, duty_cycle, parent, stop):
    reservation = workload = None

    def running():
        return not stop.is_set() and os.getppid() == parent

    try:
        if not torch.cuda.is_available():
            raise RuntimeError("当前 PyTorch 的 CUDA 不可用")
        torch.cuda.set_device(0)
        free, _ = torch.cuda.mem_get_info()
        budget = int(free * fraction)
        if duty_cycle > 0:
            workload = TrainingWorkload(torch)
            workload.step()
        # Warm up first so the reservation leaves space for training tensors and workspace.
        reserve_bytes = max(0, budget - torch.cuda.memory_reserved())
        reservation = torch.empty(reserve_bytes, dtype=torch.uint8, device="cuda")
        print(json.dumps({"allocated_mib": torch.cuda.memory_reserved() // 1024**2}), flush=True)
        while running():
            start = time.monotonic()
            while workload and running() and time.monotonic() - start < duty_cycle:
                workload.step()
            deadline = start + 1
            while running():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                stop.wait(min(remaining, 0.2))
    finally:
        del reservation, workload
        torch.cuda.empty_cache()


def main():
    parser = argparse.ArgumentParser(description="轻量 CUDA 训练与显存占用")
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--fraction", type=float, required=True)
    parser.add_argument("--duty-cycle", type=float, required=True)
    parser.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    os.environ["CUDA_VISIBLE_DEVICES"] = args.uuid
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: stop.set())
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError(f"{sys.executable} 需要安装支持 CUDA 的 PyTorch：{exc}") from exc
    torch.set_num_threads(1)
    hold_gpu(torch, args.fraction, args.duty_cycle, args.parent, stop)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
