from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from stirling.medical_redact.sidecar import (
    BundleValidationError,
    _model_digest,
    _start_parent_monitor,
    validate_model_manifest,
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest(tmp_path: Path) -> Path:
    model_file = tmp_path / "paddleocr" / "demo" / "inference.onnx"
    model_file.parent.mkdir(parents=True)
    model_file.write_bytes(b"medical-redact-model")
    file_entry = {
        "path": "paddleocr/demo/inference.onnx",
        "sha256": _sha256(model_file),
        "size": model_file.stat().st_size,
    }
    manifest = {
        "schemaVersion": 1,
        "bundleVersion": "3.2.1",
        "models": [
            {
                "id": "demo",
                "version": "1",
                "files": [file_entry],
                "sha256": _model_digest([file_entry]),
                "size": file_entry["size"],
                "backend": ["onnxruntime"],
                "runtime": {"onnx": True},
                "platform": ["macos", "windows"],
            }
        ],
    }
    manifest_path = tmp_path / "model-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest_path


def test_validate_model_manifest_accepts_verified_bundle(tmp_path: Path) -> None:
    manifest_path = _manifest(tmp_path)

    payload = validate_model_manifest(manifest_path)

    assert payload["bundleVersion"] == "3.2.1"


def test_validate_model_manifest_rejects_tampered_file(tmp_path: Path) -> None:
    manifest_path = _manifest(tmp_path)
    (tmp_path / "paddleocr" / "demo" / "inference.onnx").write_bytes(b"tampered")

    with pytest.raises(BundleValidationError, match="size mismatch|checksum mismatch"):
        validate_model_manifest(manifest_path)


def test_validate_model_manifest_rejects_path_escape(tmp_path: Path) -> None:
    manifest_path = _manifest(tmp_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["models"][0]["files"][0]["path"] = "../outside.bin"
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(BundleValidationError, match="unsafe model file path"):
        validate_model_manifest(manifest_path)


def test_parent_monitor_rejects_invalid_pid() -> None:
    with pytest.raises(ValueError, match="greater than 1"):
        _start_parent_monitor(1)
