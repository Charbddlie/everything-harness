#!/usr/bin/env python3
"""Parse a PDF with MinerU and cache the result next to the PDF."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


API_BASE = "https://mineru.net/api/v4"
DEFAULT_POLL_INTERVAL_SECONDS = 10
DEFAULT_TIMEOUT_SECONDS = 900
SUCCESS_STATUSES = {"done", "success", "completed", "finish", "finished", "succeeded"}
FAILURE_STATUSES = {"failed", "error", "canceled", "cancelled", "timeout"}


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get_api_key(script_path: Path) -> str:
    env_key = os.environ.get("MINERU_API_KEY")
    if env_key:
        return env_key

    skill_dir = script_path.resolve().parents[1]
    env_values = load_env_file(skill_dir / "key.env")
    api_key = env_values.get("MINERU_API_KEY")
    if not api_key:
        raise SystemExit(
            "MINERU_API_KEY was not found in the environment or "
            f"{skill_dir / 'key.env'}"
        )
    return api_key


def safe_folder_name(pdf_path: Path) -> str:
    name = pdf_path.stem.strip()
    name = re.sub(r"[^\w.\-一-龥]+", "_", name, flags=re.UNICODE)
    return name.strip("._") or "pdf"


def output_dir_for(pdf_path: Path, output_root: Path | None) -> Path:
    root = output_root if output_root else pdf_path.parent / ".mineru"
    return root / safe_folder_name(pdf_path)


def has_cached_parse(output_dir: Path) -> bool:
    if not output_dir.exists():
        return False
    candidates = list(output_dir.rglob("*.md"))
    candidates.extend(output_dir.rglob("*.txt"))
    candidates.extend(output_dir.rglob("*.json"))
    return any(path.is_file() and path.stat().st_size > 0 for path in candidates)


def request_json(
    method: str,
    url: str,
    api_key: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {error.code}: {detail}") from error

    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{method} {url} returned non-JSON response: {body[:500]}") from error


def find_first_key(data: Any, names: set[str]) -> Any:
    if isinstance(data, dict):
        for key, value in data.items():
            if key in names:
                return value
        for value in data.values():
            found = find_first_key(value, names)
            if found is not None:
                return found
    elif isinstance(data, list):
        for item in data:
            found = find_first_key(item, names)
            if found is not None:
                return found
    return None


def find_urls(data: Any, key_hint: str | None = None) -> list[str]:
    urls: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                if key_hint is None or key_hint in key.lower():
                    urls.append(value)
            else:
                urls.extend(find_urls(value, key_hint))
    elif isinstance(data, list):
        for item in data:
            urls.extend(find_urls(item, key_hint))
    return urls


def create_upload_task(
    api_key: str,
    pdf_path: Path,
    language: str | None,
    is_ocr: bool,
    model_version: str | None,
    enable_formula: bool,
    enable_table: bool,
) -> dict[str, Any]:
    file_spec: dict[str, Any] = {
        "name": pdf_path.name,
        "is_ocr": is_ocr,
    }

    payload: dict[str, Any] = {
        "files": [file_spec],
        "enable_formula": enable_formula,
        "enable_table": enable_table,
    }
    if language:
        payload["language"] = language
    if model_version:
        payload["model_version"] = model_version

    return request_json("POST", f"{API_BASE}/file-urls/batch", api_key, payload)


def upload_pdf(upload_url: str, pdf_path: Path) -> None:
    # MinerU's pre-signed upload URL expects the raw file body without Content-Type.
    parsed = urllib.parse.urlsplit(upload_url)
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    connection_class = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parsed.netloc, timeout=300)
    try:
        connection.putrequest("PUT", path, skip_accept_encoding=True)
        connection.putheader("Host", parsed.netloc)
        connection.putheader("Content-Length", str(pdf_path.stat().st_size))
        connection.endheaders()
        with pdf_path.open("rb") as file:
            while chunk := file.read(1024 * 1024):
                connection.send(chunk)
        response = connection.getresponse()
        detail = response.read().decode("utf-8", errors="replace")
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Upload failed: HTTP {response.status}: {detail}")
    finally:
        connection.close()


def extract_batch_id(response: dict[str, Any]) -> str:
    batch_id = response.get("data", {}).get("batch_id")
    if not batch_id:
        batch_id = find_first_key(response, {"batch_id", "batchId"})
    if not batch_id:
        raise RuntimeError(f"MinerU response did not include a batch id: {response}")
    return str(batch_id)


def extract_upload_url(response: dict[str, Any]) -> str:
    urls = response.get("data", {}).get("file_urls")
    if not urls:
        urls = find_urls(response)
    if not urls:
        raise RuntimeError(f"MinerU response did not include an upload URL: {response}")
    return urls[0]


def extract_result_zip_url(result: dict[str, Any]) -> str | None:
    data = result.get("data")
    if isinstance(data, dict):
        extract_result = data.get("extract_result")
        if isinstance(extract_result, list) and extract_result:
            first = extract_result[0]
            if isinstance(first, dict):
                for key in ("full_zip_url", "zip_url", "result_zip_url"):
                    value = first.get(key)
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        return value
        for key in ("full_zip_url", "zip_url", "result_zip_url"):
            value = data.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                return value

    urls = find_urls(result, "zip")
    return urls[0] if urls else None


def get_status(result: dict[str, Any]) -> str | None:
    status = find_first_key(result, {"status", "state"})
    return str(status).lower() if status is not None else None


def poll_result(
    api_key: str,
    batch_id: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_result: dict[str, Any] | None = None

    while time.monotonic() < deadline:
        result = request_json(
            "GET",
            f"{API_BASE}/extract-results/batch/{urllib.parse.quote(batch_id)}",
            api_key,
        )
        last_result = result
        status = get_status(result)
        zip_url = extract_result_zip_url(result)

        if zip_url:
            return result
        if status in SUCCESS_STATUSES:
            print(
                f"MinerU batch {batch_id} is complete but no result zip is available yet...",
                file=sys.stderr,
            )
        if status in FAILURE_STATUSES:
            raise RuntimeError(f"MinerU parsing failed: {json.dumps(result, ensure_ascii=False)}")

        print(f"Waiting for MinerU result for batch {batch_id}...", file=sys.stderr)
        time.sleep(poll_interval_seconds)

    raise TimeoutError(
        f"Timed out waiting for MinerU batch {batch_id}. "
        f"Last response: {json.dumps(last_result, ensure_ascii=False)}"
    )


def download_file(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=300) as response:
        target.write_bytes(response.read())


def extract_zip(zip_path: Path, output_dir: Path) -> None:
    output_root = output_dir.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            target = (output_dir / member.filename).resolve()
            if output_root not in target.parents and target != output_root:
                raise RuntimeError(f"Refusing to extract unsafe zip path: {member.filename}")
        archive.extractall(output_dir)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_metadata(output_dir: Path, pdf_path: Path, batch_id: str) -> None:
    metadata = {
        "pdf": str(pdf_path),
        "batch_id": batch_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_json(output_dir / "mineru-metadata.json", metadata)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parse a PDF with MinerU and cache the result.")
    parser.add_argument("pdf", type=Path, help="Path to the PDF file.")
    parser.add_argument(
        "--output-root",
        type=Path,
        help="Directory that contains per-PDF cache folders. Defaults to <pdf parent>/.mineru.",
    )
    parser.add_argument("--force", action="store_true", help="Reparse even if cached output exists.")
    parser.add_argument("--language", help="Optional MinerU language hint, for example ch or en.")
    parser.add_argument(
        "--no-ocr",
        action="store_true",
        help="Disable OCR when requesting MinerU parsing.",
    )
    parser.add_argument(
        "--disable-formula",
        action="store_true",
        help="Disable formula recognition.",
    )
    parser.add_argument(
        "--disable-table",
        action="store_true",
        help="Disable table recognition.",
    )
    parser.add_argument(
        "--model-version",
        default="vlm",
        help="MinerU model version. Default: vlm.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Polling timeout in seconds. Default: {DEFAULT_TIMEOUT_SECONDS}.",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL_SECONDS,
        help=f"Polling interval in seconds. Default: {DEFAULT_POLL_INTERVAL_SECONDS}.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = args.pdf.expanduser().resolve()
    if not pdf_path.exists():
        raise SystemExit(f"PDF does not exist: {pdf_path}")
    if pdf_path.suffix.lower() != ".pdf":
        raise SystemExit(f"Expected a .pdf file: {pdf_path}")

    output_dir = output_dir_for(pdf_path, args.output_root.expanduser().resolve() if args.output_root else None)
    if has_cached_parse(output_dir) and not args.force:
        print(f"Using cached MinerU output: {output_dir}")
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    api_key = get_api_key(Path(__file__))

    upload_response = create_upload_task(
        api_key=api_key,
        pdf_path=pdf_path,
        language=args.language,
        is_ocr=not args.no_ocr,
        model_version=args.model_version,
        enable_formula=not args.disable_formula,
        enable_table=not args.disable_table,
    )
    write_json(output_dir / "upload-task.json", upload_response)

    batch_id = extract_batch_id(upload_response)
    write_metadata(output_dir, pdf_path, batch_id)
    upload_url = extract_upload_url(upload_response)
    upload_pdf(upload_url, pdf_path)

    result = poll_result(
        api_key=api_key,
        batch_id=batch_id,
        timeout_seconds=args.timeout,
        poll_interval_seconds=args.poll_interval,
    )
    write_json(output_dir / "extract-results.json", result)

    zip_url = extract_result_zip_url(result)
    if not zip_url:
        print(f"MinerU completed, but no result zip URL was found. Output: {output_dir}")
        return 0

    zip_path = output_dir / "mineru-result.zip"
    download_file(zip_url, zip_path)
    extract_zip(zip_path, output_dir)

    print(f"MinerU output: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
