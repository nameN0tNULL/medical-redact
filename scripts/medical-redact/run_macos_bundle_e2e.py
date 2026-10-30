#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import http.client
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "frontend/src/editor/core/tests/test-fixtures/medical-redact"
BUNDLE = Path(
    os.environ.get(
        "MEDICAL_REDACT_BUNDLE",
        ROOT / "frontend/src-tauri/target/release/bundle/macos/中文医疗资料自动脱敏.app",
    )
).resolve()
EXECUTABLE = BUNDLE / "Contents/MacOS/Stirling-PDF"
E2E_ROOT = ROOT / ".cache/medical-redact-bundle-e2e"
E2E_HOME = E2E_ROOT / "home"
RESULT = E2E_ROOT / "result.json"
BACKEND_LOG = E2E_HOME / "Library/Logs/Stirling-PDF/tauri-backend.log"
OFFLINE = os.environ.get("MEDICAL_REDACT_OFFLINE", "").lower() in {"1", "true", "yes"}

ACCEPTED = [
    "01_outpatient_record_text.pdf",
    "02_inpatient_record_text.pdf",
    "03_lab_report_text.pdf",
    "04_imaging_report_scan.png",
    "05_ultrasound_report_scan_rotated.png",
    "06_lab_slip_low_contrast.png",
]
REJECTED = [
    "07_outpatient_record_word.docx",
    "08_imaging_report_word.docx",
    "09_lab_report_word.docx",
]
EXPECTED_PAGES = {
    "01_outpatient_record_text.pdf": 2,
    "02_inpatient_record_text.pdf": 3,
    "03_lab_report_text.pdf": 1,
    "04_imaging_report_scan.png": 1,
    "05_ultrasound_report_scan_rotated.png": 1,
    "06_lab_slip_low_contrast.png": 1,
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_child_pid(app_pid: int, marker: str, timeout: float = 30.0) -> int | None:
    deadline = time.time() + timeout
    while time.time() <= deadline:
        output = subprocess.check_output(
            ["ps", "-ax", "-o", "pid=,ppid=,command="],
            text=True,
        )
        for line in output.splitlines():
            parts = line.strip().split(maxsplit=2)
            if len(parts) != 3:
                continue
            pid_s, ppid_s, command = parts
            if int(ppid_s) == app_pid and marker in command:
                return int(pid_s)
        if timeout <= 0:
            break
        time.sleep(0.25)
    return None


def wait_for_child(app_pid: int, marker: str, description: str) -> int:
    pid = find_child_pid(app_pid, marker)
    if pid is None:
        raise RuntimeError(f"{description} did not start")
    return pid


def listening_port(pid: int, timeout: float = 30.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = subprocess.run(
            ["lsof", "-Pan", "-p", str(pid), "-iTCP", "-sTCP:LISTEN"],
            text=True,
            capture_output=True,
        )
        lines = [line for line in run.stdout.splitlines()[1:] if line.strip()]
        for line in lines:
            address = line.split()[-2] if "(LISTEN)" in line and len(line.split()) >= 2 else ""
            if ":" not in address:
                address = line.split()[-1].replace("(LISTEN)", "")
            try:
                return int(address.rsplit(":", 1)[1])
            except (IndexError, ValueError):
                continue
        time.sleep(0.25)
    raise RuntimeError("Bundled Java backend did not open a TCP port")


def request_json(
    port: int,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    expected: int = 200,
    timeout: float = 20,
):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    raw = response.read()
    status = response.status
    content_type = response.getheader("Content-Type") or ""
    connection.close()
    if status != expected:
        raise AssertionError(
            f"{method} {path}: expected HTTP {expected}, got {status}: {raw[:500]!r}"
        )
    if "application/json" in content_type:
        return json.loads(raw.decode("utf-8"))
    return raw


def multipart(files: list[Path]) -> tuple[bytes, str]:
    boundary = f"----medical-redact-e2e-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for path in files:
        if path.suffix.lower() == ".pdf":
            content_type = "application/pdf"
        elif path.suffix.lower() == ".png":
            content_type = "image/png"
        elif path.suffix.lower() in {".jpg", ".jpeg"}:
            content_type = "image/jpeg"
        elif path.suffix.lower() == ".docx":
            content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            content_type = "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'
                ).encode(),
                f"Content-Type: {content_type}\r\n\r\n".encode(),
                path.read_bytes(),
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def assert_startup_order(engine_port: int) -> None:
    raw = BACKEND_LOG.read_text(encoding="utf-8")
    start_marker = f"Starting bundled medical Engine on http://127.0.0.1:{engine_port}"
    started = raw.rfind(start_marker)
    ready = raw.find("Bundled medical Engine is ready", started)
    spring = raw.find("Equivalent command:", ready)
    if not (started >= 0 and ready > started and spring > ready):
        raise AssertionError("Expected Tauri -> Engine ready -> Spring startup order was not observed")
    if OFFLINE and "Medical Engine outbound network disabled by macOS sandbox" not in raw:
        raise AssertionError("Offline E2E did not enable the Engine kernel network sandbox")


def process_is_running(pid: int) -> bool:
    probe = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        text=True,
        capture_output=True,
    )
    state = probe.stdout.strip()
    return probe.returncode == 0 and bool(state) and not state.startswith("Z")


def start_bundle() -> tuple[subprocess.Popen[bytes], int, int, int, int]:
    env = os.environ.copy()
    env["HOME"] = str(E2E_HOME)
    if OFFLINE:
        env.update(
            {
                "MEDICAL_REDACT_ENGINE_BLOCK_EXTERNAL_NETWORK": "1",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
                "HTTP_PROXY": "http://127.0.0.1:9",
                "HTTPS_PROXY": "http://127.0.0.1:9",
                "ALL_PROXY": "http://127.0.0.1:9",
                "NO_PROXY": "127.0.0.1,localhost,::1",
            }
        )
    E2E_HOME.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [str(EXECUTABLE)],
        cwd=str(E2E_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        engine_pid = wait_for_child(process.pid, "medical-redact-engine", "Bundled medical Engine")
        engine_port = listening_port(engine_pid, timeout=30)
        request_json(
            engine_port,
            "GET",
            "/api/v1/medical-redact/runtime/capabilities",
            expected=401,
        )
        java_pid = wait_for_child(process.pid, "stirling-pdf-", "Bundled Java backend")
        port = listening_port(java_pid, timeout=90)
        deadline = time.time() + 30
        last_error: Exception | None = None
        while time.time() < deadline:
            try:
                request_json(port, "GET", "/api/v1/config/app-config")
                assert_startup_order(engine_port)
                return process, java_pid, port, engine_pid, engine_port
            except Exception as exc:
                last_error = exc
                time.sleep(0.5)
        raise RuntimeError(f"Backend never became ready: {last_error}")
    except Exception:
        stop_bundle(process)
        raise


def stop_bundle(process: subprocess.Popen[bytes]) -> None:
    engine_pid = find_child_pid(process.pid, "medical-redact-engine", timeout=0)
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if engine_pid is None:
        return
    deadline = time.time() + 10
    while time.time() < deadline and process_is_running(engine_pid):
        time.sleep(0.25)
    if process_is_running(engine_pid):
        os.kill(engine_pid, signal.SIGKILL)
        raise AssertionError(f"Bundled medical Engine did not exit with Tauri parent: {engine_pid}")


def assert_source_read_only(relative_path: str) -> None:
    app_data = E2E_HOME / "Library/Application Support/Stirling-PDF"
    source = app_data / "medical-redact/workspace" / relative_path
    if not source.is_file():
        raise AssertionError(f"Source file not found in isolated workspace: {source}")
    if source.stat().st_mode & 0o222:
        raise AssertionError(f"Source file is writable: {source}")


def review_state(page: dict, *, full_page: bool = True) -> dict:
    width = float(page["width"])
    height = float(page["height"])
    if full_page:
        x = 0.0
        y = 0.0
        box_width = width
        box_height = height
    else:
        x = round(width * 0.02, 2)
        y = round(height * 0.02, 2)
        box_width = round(width * 0.05, 2)
        box_height = round(height * 0.05, 2)
    return {
        "entityType": "PATIENT_NAME",
        "entityRole": "PATIENT",
        "box": {
            "pageId": page["id"],
            "x": x,
            "y": y,
            "width": box_width,
            "height": box_height,
        },
        "selectionState": "SELECTED",
        "selectionSource": "MANUAL_RECTANGLE",
    }


def save_review_action(
    port: int,
    batch_id: str,
    document: dict,
    target_id: str,
    action: str,
    before: dict | None,
    after: dict | None,
) -> dict:
    return request_json(
        port,
        "POST",
        f"/api/v1/medical-redact/batches/{batch_id}/review-actions",
        body=json.dumps(
            {
                "documentId": document["id"],
                "targetType": "MANUAL_RECTANGLE",
                "targetId": target_id,
                "action": action,
                "before": before,
                "after": after,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )


def latest_report(batch: dict, document_id: str) -> dict | None:
    for report in reversed(batch["verificationReports"]):
        if report["documentId"] == document_id:
            return report
    return None


def assert_secure_output(raw: bytes, expected_pages: int, source_name: str) -> dict:
    if not raw.startswith(b"%PDF"):
        raise AssertionError(f"Verified output is not a PDF for {source_name}")
    with fitz.open(stream=raw, filetype="pdf") as pdf:
        if pdf.page_count != expected_pages:
            raise AssertionError(
                f"Verified output page count mismatch for {source_name}: {pdf.page_count}"
            )
        extracted = "".join(page.get_text() for page in pdf)
        if extracted.strip():
            raise AssertionError(f"Verified output retained a text layer for {source_name}")
        metadata = pdf.metadata or {}
        sensitive_metadata = {
            key: value
            for key, value in metadata.items()
            if key in {"title", "author", "subject", "keywords", "creator"}
            and value
            and value.strip()
        }
        if sensitive_metadata:
            raise AssertionError(
                f"Verified output retained sensitive metadata for {source_name}: "
                f"{sensitive_metadata}"
            )
    return {
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "pages": expected_pages,
    }


def main() -> None:
    if sys.platform != "darwin":
        raise SystemExit("This bundle E2E currently targets the macOS P0 acceptance platform")
    if not EXECUTABLE.is_file():
        raise SystemExit(f"Bundle executable missing: {EXECUTABLE}")
    if not FIXTURES.is_dir():
        raise SystemExit(f"Fixtures missing: {FIXTURES}")

    shutil.rmtree(E2E_ROOT, ignore_errors=True)
    E2E_ROOT.mkdir(parents=True)

    first, first_java, first_port, first_engine, first_engine_port = start_bundle()
    summary: dict[str, object] = {
        "bundle": str(BUNDLE.relative_to(ROOT)),
        "network_mode": (
            "engine-kernel-no-egress+offline-env" if OFFLINE else "host-default"
        ),
        "first_launch": {
            "app_pid": first.pid,
            "engine_pid": first_engine,
            "engine_port": first_engine_port,
            "java_pid": first_java,
            "spring_port": first_port,
            "engine_auth_without_secret": 401,
            "startup_order": "Tauri -> Engine ready -> Spring",
        },
    }
    try:
        created = request_json(
            first_port,
            "POST",
            "/api/v1/medical-redact/batches",
            body=json.dumps(
                {"name": "E2E 综合医疗资料脱敏", "knownEntities": []}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        batch_id = created["id"]

        accepted_paths = [FIXTURES / name for name in ACCEPTED]
        body, boundary = multipart(accepted_paths)
        imported = request_json(
            first_port,
            "POST",
            f"/api/v1/medical-redact/batches/{batch_id}/documents",
            body=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        if imported["documentCount"] != len(ACCEPTED):
            raise AssertionError(imported)
        if sum(document["pageCount"] for document in imported["documents"]) != 9:
            raise AssertionError("Expected 9 pages across synthetic PDF/PNG fixtures")

        by_name = {document["originalFilename"]: document for document in imported["documents"]}
        for name in ACCEPTED:
            document = by_name[name]
            fixture = FIXTURES / name
            if document["pageCount"] != EXPECTED_PAGES[name]:
                raise AssertionError(f"Page count mismatch for {name}: {document['pageCount']}")
            if document["sha256"] != sha256(fixture):
                raise AssertionError(f"SHA256 mismatch for {name}")
            if name in document["sourceRelativePath"]:
                raise AssertionError(f"Original filename leaked into source path: {name}")
            assert_source_read_only(document["sourceRelativePath"])
            raw = request_json(
                first_port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/source",
            )
            if hashlib.sha256(raw).hexdigest() != document["sha256"]:
                raise AssertionError(f"Downloaded source hash mismatch for {name}")

        native_document = by_name["01_outpatient_record_text.pdf"]
        native_regions = request_json(
            first_port,
            "GET",
            f"/api/v1/medical-redact/batches/{batch_id}/documents/{native_document['id']}/text-regions",
            timeout=120,
        )
        native_pii_types = {
            candidate["entityType"] for candidate in native_regions["piiCandidates"]
        }
        if not native_regions["piiAvailable"] or not native_pii_types:
            raise AssertionError("Bundled Engine did not return PII candidates for native text")

        imaging_document = by_name["04_imaging_report_scan.png"]
        text_regions = request_json(
            first_port,
            "GET",
            f"/api/v1/medical-redact/batches/{batch_id}/documents/{imaging_document['id']}/text-regions",
            timeout=120,
        )
        if not text_regions["engineAvailable"]:
            raise AssertionError("Bundled Engine was unavailable for real scan OCR")
        if not text_regions["piiAvailable"]:
            raise AssertionError("Bundled Engine was unavailable for scan PII detection")
        if not text_regions["pages"] or text_regions["pages"][0]["mode"] != "PADDLE_OCR":
            raise AssertionError("Scan fixture did not use bundled Paddle OCR")
        if not text_regions["pages"][0]["tokens"]:
            raise AssertionError("Bundled Paddle OCR returned no tokens")
        scan_pii_types = {candidate["entityType"] for candidate in text_regions["piiCandidates"]}

        summary["first_launch"]["real_ocr_pii"] = {
            "native_pii_types": sorted(native_pii_types),
            "scan_document": "04_imaging_report_scan.png",
            "scan_page_mode": text_regions["pages"][0]["mode"],
            "scan_token_count": len(text_regions["pages"][0]["tokens"]),
            "scan_pii_types": sorted(scan_pii_types),
        }

        p04_outputs: dict[str, dict] = {}
        review_action_count = 0
        for name in ACCEPTED:
            document = by_name[name]
            review_raw = request_json(
                first_port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/review",
            )
            if not review_raw.startswith(b"%PDF"):
                raise AssertionError(f"Review derivative is not PDF for {name}")

            request_json(
                first_port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/output",
                expected=409,
            )

            for page_index, page in enumerate(document["pages"], start=1):
                state = review_state(page)
                save_review_action(
                    first_port,
                    batch_id,
                    document,
                    f"manual-e2e-{document['id']}-page-{page_index}",
                    "ADD_MANUAL",
                    None,
                    state,
                )
                review_action_count += 1
            finalized = request_json(
                first_port,
                "POST",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/finalize",
                body=b"{}",
                headers={"Content-Type": "application/json"},
                timeout=180,
            )
            report = latest_report(finalized, document["id"])
            if not report or report["status"] != "PASS" or report["findingCount"] != 0:
                raise AssertionError(f"Verification did not PASS for {name}: {report}")
            output_filename = report["outputFilename"]
            if not output_filename or not output_filename.startswith("DOC"):
                raise AssertionError(f"Unsafe output filename for {name}: {output_filename}")
            if Path(name).stem.lower() in output_filename.lower():
                raise AssertionError(f"Original filename leaked into output name for {name}")

            output_raw = request_json(
                first_port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/output",
            )
            output_check = assert_secure_output(output_raw, document["pageCount"], name)
            if report["sha256"] != output_check["sha256"]:
                raise AssertionError(f"Output SHA256 report mismatch for {name}")
            p04_outputs[name] = {
                "verification": report["status"],
                "finding_count": report["findingCount"],
                "output_filename": output_filename,
                **output_check,
            }

        invalidated_name = ACCEPTED[0]
        invalidated_document = by_name[invalidated_name]
        invalidated = save_review_action(
            first_port,
            batch_id,
            invalidated_document,
            f"manual-e2e-invalidation-{invalidated_document['id']}",
            "ADD_MANUAL",
            None,
            review_state(invalidated_document["pages"][0], full_page=False),
        )
        review_action_count += 1
        if latest_report(invalidated, invalidated_document["id"]) is not None:
            raise AssertionError("A review change did not invalidate the previous PASS report")
        request_json(
            first_port,
            "GET",
            f"/api/v1/medical-redact/batches/{batch_id}/documents/{invalidated_document['id']}/output",
            expected=409,
        )
        reverified = request_json(
            first_port,
            "POST",
            f"/api/v1/medical-redact/batches/{batch_id}/documents/{invalidated_document['id']}/finalize",
            body=b"{}",
            headers={"Content-Type": "application/json"},
            timeout=180,
        )
        reverified_report = latest_report(reverified, invalidated_document["id"])
        if not reverified_report or reverified_report["status"] != "PASS":
            raise AssertionError("Document did not PASS after re-verification")
        reverified_raw = request_json(
            first_port,
            "GET",
            f"/api/v1/medical-redact/batches/{batch_id}/documents/{invalidated_document['id']}/output",
        )
        assert_secure_output(
            reverified_raw,
            invalidated_document["pageCount"],
            invalidated_name,
        )
        p04_outputs[invalidated_name]["pass_invalidated_after_review_change"] = True
        p04_outputs[invalidated_name]["reverified"] = True

        rejected_statuses: dict[str, int] = {}
        for name in REJECTED:
            body, boundary = multipart([FIXTURES / name])
            connection = http.client.HTTPConnection("127.0.0.1", first_port, timeout=20)
            connection.request(
                "POST",
                f"/api/v1/medical-redact/batches/{batch_id}/documents",
                body=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
            response = connection.getresponse()
            response.read()
            rejected_statuses[name] = response.status
            connection.close()
            if response.status != 400:
                raise AssertionError(f"DOCX should be rejected in P0, {name} returned {response.status}")

        cleanup = request_json(
            first_port,
            "POST",
            "/api/v1/medical-redact/workspace/cleanup-temp",
            body=b"{}",
            headers={"Content-Type": "application/json"},
        )
        summary["first_launch"].update(
            {
                "batch_id": batch_id,
                "documents": imported["documentCount"],
                "pages": sum(document["pageCount"] for document in imported["documents"]),
                "docx_status": rejected_statuses,
                "p04_outputs": p04_outputs,
                "cleanup_deleted_files": cleanup["deletedFiles"],
            }
        )
    finally:
        stop_bundle(first)

    second, second_java, second_port, second_engine, second_engine_port = start_bundle()
    try:
        if second_engine_port == first_engine_port:
            raise AssertionError("Bundled Engine reused the previous ephemeral port after restart")
        if second_port == first_port:
            raise AssertionError("Bundled Spring backend reused the previous ephemeral port after restart")
        batches = request_json(second_port, "GET", "/api/v1/medical-redact/batches")
        matching = [item for item in batches if item["id"] == batch_id]
        if len(matching) != 1:
            raise AssertionError("Persisted batch was not recovered after bundle restart")
        recovered = matching[0]
        if recovered["documentCount"] != len(ACCEPTED):
            raise AssertionError("Recovered batch document count changed after restart")
        if recovered["status"] != "VERIFIED":
            raise AssertionError(f"Recovered batch is not VERIFIED: {recovered['status']}")
        if len(recovered["verificationReports"]) != len(ACCEPTED):
            raise AssertionError("Verification reports were not recovered after restart")
        if len(recovered["reviewActions"]) != review_action_count:
            raise AssertionError(
                "Review actions were not recovered after restart: "
                f"expected {review_action_count}, got {len(recovered['reviewActions'])}"
            )

        recovered_outputs: dict[str, str] = {}
        recovered_by_name = {
            document["originalFilename"]: document for document in recovered["documents"]
        }
        for name in ACCEPTED:
            document = recovered_by_name[name]
            raw = request_json(
                second_port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/output",
            )
            output_check = assert_secure_output(raw, document["pageCount"], name)
            recovered_outputs[name] = output_check["sha256"]

        summary["second_launch"] = {
            "app_pid": second.pid,
            "engine_pid": second_engine,
            "engine_port": second_engine_port,
            "java_pid": second_java,
            "spring_port": second_port,
            "recovered_batch_id": recovered["id"],
            "documents": recovered["documentCount"],
            "review_actions": len(recovered["reviewActions"]),
            "verification_reports": len(recovered["verificationReports"]),
            "status": recovered["status"],
            "recovered_outputs": recovered_outputs,
        }
    finally:
        stop_bundle(second)

    RESULT.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Medical-redact bundled app E2E passed")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
