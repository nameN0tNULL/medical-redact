from __future__ import annotations

import argparse
import hashlib
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

import requests

_BASE_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0"


@dataclass(frozen=True)
class ModelSpec:
    archive_name: str
    directory_name: str
    checksums: dict[str, str]


_MODELS = {
    "PP-LCNet_x1_0_doc_ori": ModelSpec(
        archive_name="PP-LCNet_x1_0_doc_ori_infer.tar",
        directory_name="PP-LCNet_x1_0_doc_ori_infer",
        checksums={
            "inference.json": "3580978602f309c3554508dd85d4fe09b73a7e0d80d7f9e63258f5b72c390c69",
            "inference.pdiparams": "e8d6e7c5d264507e40e58a655779059d616b20d7441ea22047d829eb3931989c",
            "inference.yml": "9e195eb729a8173588cd0e8a852c8b373aa606e79e77b4ac7d8346f5426caf26",
        },
    ),
    "PP-LCNet_x1_0_textline_ori": ModelSpec(
        archive_name="PP-LCNet_x1_0_textline_ori_infer.tar",
        directory_name="PP-LCNet_x1_0_textline_ori_infer",
        checksums={
            "inference.json": "b81929eeaff8e52db0fafb49c9fbfc5bc0572f81641fe0179cc52096323fb4d4",
            "inference.pdiparams": "0de2bcf996cf553e2b848dd7b1769dafffc6917b1ccdf55c1d8efe7909fbf743",
            "inference.yml": "8d5120d0e1a30a9df7ed46aa9119da3796ed066777089d1c1d705f132d5e90f9",
        },
    ),
    "PP-OCRv6_small_det": ModelSpec(
        archive_name="PP-OCRv6_small_det_infer.tar",
        directory_name="PP-OCRv6_small_det_infer",
        checksums={
            "inference.json": "89240f689a4a77aad75ef55a8df0a15c8e1d4980a327d17e58f24bbadde5aeab",
            "inference.pdiparams": "5043d4ccc8d63402ccea8feefcee4db57077431a873e78d2191836a178a492da",
            "inference.yml": "193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516",
        },
    ),
    "PP-OCRv6_small_rec": ModelSpec(
        archive_name="PP-OCRv6_small_rec_infer.tar",
        directory_name="PP-OCRv6_small_rec_infer",
        checksums={
            "inference.json": "f0bf53c853937a917affdd74467472167727f8ab0f0f7bded01c4a16c27e46e6",
            "inference.pdiparams": "406e1e689c9a7fbb04178007a3fe10cf852afe7bf8bb3bc6dbb9d532b13bd907",
            "inference.yml": "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
        },
    ),
}


def default_model_root() -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / ".cache" / "medical-redact" / "models"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model(root: Path, spec: ModelSpec) -> bool:
    directory = root / spec.directory_name
    return all(
        (directory / filename).is_file() and sha256(directory / filename) == expected
        for filename, expected in spec.checksums.items()
    )


def download_model(root: Path, name: str, spec: ModelSpec) -> None:
    root.mkdir(parents=True, exist_ok=True)
    url = f"{_BASE_URL}/{spec.archive_name}"
    print(f"Downloading {name} from Paddle model hosting...")
    with tempfile.TemporaryDirectory(prefix=".ocr-model-", dir=root) as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        archive = temp_dir / spec.archive_name
        with requests.get(url, stream=True, timeout=(15, 180)) as response:
            response.raise_for_status()
            with archive.open("wb") as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        output.write(chunk)

        extract_dir = temp_dir / "extract"
        extract_dir.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(extract_dir, filter="data")

        extracted = extract_dir / spec.directory_name
        if not extracted.is_dir():
            raise RuntimeError(f"Archive for {name} did not contain {spec.directory_name}")
        target = root / spec.directory_name
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(extracted), str(target))

    if not verify_model(root, spec):
        raise RuntimeError(f"Checksum verification failed for {name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download and verify the local PP-OCRv6 models used by medical redaction."
    )
    parser.add_argument(
        "--model-root",
        type=Path,
        default=default_model_root(),
        help="Destination model directory (default: repo .cache/medical-redact/models).",
    )
    args = parser.parse_args()
    root = args.model_root.expanduser().resolve()

    for name, spec in _MODELS.items():
        if verify_model(root, spec):
            print(f"{name}: verified")
            continue
        download_model(root, name, spec)
        print(f"{name}: downloaded and verified")

    print(f"Medical redaction OCR models ready: {root}")


if __name__ == "__main__":
    main()
