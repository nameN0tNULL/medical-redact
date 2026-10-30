#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import requests
from PIL import Image

_OCR_IMAGE_FIXTURES = (
    (
        "04_imaging_report_scan.png",
        ("测试患者甲", "11010119900307451X", "EXAM-CT-20261024-09"),
    ),
    (
        "05_ultrasound_report_scan_rotated.png",
        ("测试患者甲", "13800000001", "ZY-20261024-0007"),
    ),
    (
        "06_lab_slip_low_contrast.png",
        ("测试患者甲", "13800000001", "SAMPLE-20261024-A17"),
    ),
)


def fixture_root() -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "frontend" / "src" / "editor" / "core" / "tests" / "test-fixtures" / "medical-redact"


def require_ok(response: requests.Response, operation: str) -> requests.Response:
    if response.status_code != 200:
        raise RuntimeError(f"{operation} failed: HTTP {response.status_code}: {response.text[:1000]}")
    return response


def post_json(base_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(
        base_url + path,
        json=payload,
        timeout=180,
    )
    return require_ok(response, f"POST {path}").json()


def get_json(base_url: str, path: str) -> dict[str, Any]:
    response = requests.get(base_url + path, timeout=180)
    return require_ok(response, f"GET {path}").json()


def document_by_filename(batch: dict[str, Any], filename: str) -> dict[str, Any]:
    for document in batch["documents"]:
        if document["originalFilename"] == filename:
            return document
    raise AssertionError(f"Imported document not found: {filename}")


def token_by_text(regions: dict[str, Any], expected: str) -> dict[str, Any]:
    for token in regions["pages"][0]["tokens"]:
        if token["text"] == expected:
            return token
    raise AssertionError(f"OCR token not found: {expected}")


def region_for_token(regions: dict[str, Any], token_id: str) -> dict[str, Any]:
    for region in regions["pages"][0]["regions"]:
        if token_id in region["tokenIds"]:
            return region
    raise AssertionError(f"Selectable region not found for token: {token_id}")


def bounding_box(region: dict[str, Any]) -> dict[str, Any]:
    xs = [float(point["x"]) for point in region["polygon"]]
    ys = [float(point["y"]) for point in region["polygon"]]
    return {
        "pageId": region["pageId"],
        "x": min(xs),
        "y": min(ys),
        "width": max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }


def assert_real_ocr(
    response: dict[str, Any],
    expected_texts: tuple[str, ...],
) -> None:
    assert response["engineAvailable"] is True
    assert len(response["pages"]) == 1
    page = response["pages"][0]
    assert page["mode"] == "PADDLE_OCR"
    assert len(page["regions"]) > 10
    tokens = page["tokens"]
    assert all(token["source"] == "PADDLE_OCR" for token in tokens)
    recognized = "|".join(token["text"] for token in tokens)
    for expected in expected_texts:
        assert expected in recognized, (expected, recognized)


def verify_output(
    output: bytes,
    box: dict[str, Any],
    page_width: float,
    page_height: float,
) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as temp:
        temp.write(output)
        temp.flush()
        document = pdfium.PdfDocument(temp.name)
        assert len(document) == 1
        page = document[0]

        text_page = page.get_textpage()
        extracted = text_page.get_text_range()
        assert "测试患者甲" not in extracted

        image = page.render(scale=1).to_pil().convert("RGB")
        scale_x = image.width / page_width
        scale_y = image.height / page_height
        left = max(0, min(image.width - 1, int(box["x"] * scale_x)))
        top = max(0, min(image.height - 1, int(box["y"] * scale_y)))
        right = max(
            left + 1,
            min(image.width, int((box["x"] + box["width"]) * scale_x + 0.999)),
        )
        bottom = max(
            top + 1,
            min(image.height, int((box["y"] + box["height"]) * scale_y + 0.999)),
        )

        dark = 0
        total = 0
        pixels = image.load()
        for y in range(top, bottom):
            for x in range(left, right):
                red, green, blue = pixels[x, y]
                if red < 32 and green < 32 and blue < 32:
                    dark += 1
                total += 1
        assert total > 100
        dark_ratio = dark / total
        assert dark_ratio > 0.90, dark_ratio
        return {
            "pagePixels": [image.width, image.height],
            "selectedBoxPixels": [left, top, right - left, bottom - top],
            "darkRatio": round(dark_ratio, 4),
            "extractableTextLength": len(extracted),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the real P1.2 Spring -> PaddleOCR -> review -> finalization E2E.")
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    root = fixture_root()
    started = time.monotonic()

    batch = post_json(
        base_url,
        "/api/v1/medical-redact/batches",
        {"name": "P1.2 real PaddleOCR E2E"},
    )
    batch_id = batch["id"]

    with tempfile.TemporaryDirectory(prefix="medical-redact-p12-") as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        scanned_pdf_name = "04_imaging_report_scan_wrapped.pdf"
        scanned_pdf = temp_dir / scanned_pdf_name
        with Image.open(root / "04_imaging_report_scan.png") as source_image:
            source_image.convert("RGB").save(scanned_pdf, "PDF", resolution=200.0)

        upload_specs = [
            *((root / filename, "image/png") for filename, _ in _OCR_IMAGE_FIXTURES),
            (scanned_pdf, "application/pdf"),
            (root / "01_outpatient_record_text.pdf", "application/pdf"),
        ]
        with ExitStack() as stack:
            multipart = []
            for path, mime_type in upload_specs:
                stream = stack.enter_context(path.open("rb"))
                multipart.append(("files", (path.name, stream, mime_type)))
            imported_response = requests.post(
                f"{base_url}/api/v1/medical-redact/batches/{batch_id}/documents",
                files=multipart,
                timeout=180,
            )
            imported = require_ok(imported_response, "multipart import").json()

    assert len(imported["documents"]) == 5
    extracted_by_filename: dict[str, dict[str, Any]] = {}
    extraction_summary: list[dict[str, Any]] = []
    for filename, expected_texts in _OCR_IMAGE_FIXTURES:
        document = document_by_filename(imported, filename)
        regions = get_json(
            base_url,
            (f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/text-regions"),
        )
        assert_real_ocr(regions, expected_texts)
        extracted_by_filename[filename] = regions
        page = regions["pages"][0]
        extraction_summary.append(
            {
                "filename": filename,
                "mode": page["mode"],
                "tokens": len(page["tokens"]),
                "regions": len(page["regions"]),
                "elapsedMs": page["elapsedMs"],
                "warningCode": page["warningCode"],
            }
        )

    scanned_pdf_document = document_by_filename(imported, scanned_pdf_name)
    scanned_pdf_regions = get_json(
        base_url,
        (f"/api/v1/medical-redact/batches/{batch_id}/documents/{scanned_pdf_document['id']}/text-regions"),
    )
    assert_real_ocr(
        scanned_pdf_regions,
        ("测试患者甲", "11010119900307451X", "EXAM-CT-20261024-09"),
    )
    scanned_pdf_page = scanned_pdf_regions["pages"][0]
    extraction_summary.append(
        {
            "filename": scanned_pdf_name,
            "mode": scanned_pdf_page["mode"],
            "tokens": len(scanned_pdf_page["tokens"]),
            "regions": len(scanned_pdf_page["regions"]),
            "elapsedMs": scanned_pdf_page["elapsedMs"],
            "warningCode": scanned_pdf_page["warningCode"],
        }
    )

    native_document = document_by_filename(imported, "01_outpatient_record_text.pdf")
    native_regions = get_json(
        base_url,
        (f"/api/v1/medical-redact/batches/{batch_id}/documents/{native_document['id']}/text-regions"),
    )
    assert native_regions["engineAvailable"] is False
    assert len(native_regions["pages"]) == 2
    assert all(page["mode"] == "PDF_TEXT" for page in native_regions["pages"])
    assert all(page["tokens"] for page in native_regions["pages"])
    assert all(token["source"] == "PDF_TEXT" for page in native_regions["pages"] for token in page["tokens"])
    extraction_summary.append(
        {
            "filename": "01_outpatient_record_text.pdf",
            "mode": "PDF_TEXT",
            "tokens": sum(len(page["tokens"]) for page in native_regions["pages"]),
            "regions": sum(len(page["regions"]) for page in native_regions["pages"]),
            "elapsedMs": sum(page["elapsedMs"] for page in native_regions["pages"]),
            "warningCode": None,
        }
    )

    clean_filename = _OCR_IMAGE_FIXTURES[0][0]
    clean_document = document_by_filename(imported, clean_filename)
    clean_regions = extracted_by_filename[clean_filename]
    patient_token = token_by_text(clean_regions, "测试患者甲")
    patient_region = region_for_token(clean_regions, patient_token["id"])
    box = bounding_box(patient_region)

    selected = post_json(
        base_url,
        f"/api/v1/medical-redact/batches/{batch_id}/review-actions",
        {
            "documentId": clean_document["id"],
            "targetType": "TEXT_REGION",
            "targetId": patient_region["id"],
            "action": "SELECT_TEXT",
            "before": None,
            "after": {
                "entityType": "PATIENT_NAME",
                "entityRole": "PATIENT",
                "box": box,
                "selectionState": "SELECTED",
                "selectionSource": "USER",
            },
        },
    )
    assert len(selected["reviewActions"]) == 1
    assert selected["reviewActions"][0]["targetType"] == "TEXT_REGION"
    assert selected["reviewActions"][0]["action"] == "SELECT_TEXT"
    assert "测试患者甲" not in json.dumps(selected["reviewActions"][0], ensure_ascii=False)

    finalized = post_json(
        base_url,
        (f"/api/v1/medical-redact/batches/{batch_id}/documents/{clean_document['id']}/finalize"),
        {},
    )
    reports = [report for report in finalized["verificationReports"] if report["documentId"] == clean_document["id"]]
    assert reports
    report = reports[-1]
    assert report["status"] == "PASS"
    assert report["findingCount"] == 0

    output_response = requests.get(
        (f"{base_url}/api/v1/medical-redact/batches/{batch_id}/documents/{clean_document['id']}/output"),
        timeout=180,
    )
    output = require_ok(output_response, "download verified output").content
    page = clean_document["pages"][0]
    output_check = verify_output(
        output,
        box,
        float(page["width"]),
        float(page["height"]),
    )

    print(
        json.dumps(
            {
                "status": "PASS",
                "batchId": batch_id,
                "documents": extraction_summary,
                "selectedToken": patient_token["text"],
                "selectedRegionId": patient_region["id"],
                "verification": {
                    "status": report["status"],
                    "findingCount": report["findingCount"],
                    "outputFilename": report["outputFilename"],
                },
                "outputCheck": output_check,
                "elapsedSeconds": round(time.monotonic() - started, 2),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
