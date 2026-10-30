#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "scripts/medical-redact/run_macos_bundle_e2e.py"
TESTING = ROOT / "testing"
SAMPLES = [
    TESTING / "样例_01_急诊病历.png",
    TESTING / "样例_02_门诊病历.png",
    TESTING / "样例_03_急诊电子病历.png",
    TESTING / "样例_04_出院小结_标识已合成.jpg",
]


def load_runner():
    spec = importlib.util.spec_from_file_location("medical_redact_bundle_e2e", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load bundle E2E helper: {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    e2e_root = ROOT / ".cache/medical-redact-real-samples-e2e"
    module.E2E_ROOT = e2e_root
    module.E2E_HOME = e2e_root / "home"
    module.RESULT = e2e_root / "result.json"
    module.BACKEND_LOG = (
        module.E2E_HOME / "Library/Logs/Stirling-PDF/tauri-backend.log"
    )
    return module


def box_from_points(points: list[dict[str, Any]]) -> dict[str, float] | None:
    if len(points) < 4:
        return None
    xs = [float(point["x"]) for point in points]
    ys = [float(point["y"]) for point in points]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    if right <= left or bottom <= top:
        return None
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def auto_box(region: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any] | None:
    region_box = box_from_points(region.get("polygon") or [])
    if region_box is None:
        return None

    intersections: list[dict[str, float]] = []
    region_right = region_box["x"] + region_box["width"]
    region_bottom = region_box["y"] + region_box["height"]
    for polygon in candidate.get("alignment", {}).get("polygons", []):
        if polygon.get("pageId") != region.get("pageId"):
            continue
        polygon_box = box_from_points(polygon.get("points") or [])
        if polygon_box is None:
            continue
        left = max(region_box["x"], polygon_box["x"])
        top = max(region_box["y"], polygon_box["y"])
        right = min(region_right, polygon_box["x"] + polygon_box["width"])
        bottom = min(region_bottom, polygon_box["y"] + polygon_box["height"])
        if right > left and bottom > top:
            intersections.append(
                {"left": left, "top": top, "right": right, "bottom": bottom}
            )

    if not intersections:
        return None
    left = min(item["left"] for item in intersections)
    top = min(item["top"] for item in intersections)
    right = max(item["right"] for item in intersections)
    bottom = max(item["bottom"] for item in intersections)
    return {
        "pageId": region["pageId"],
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def eligible_candidate(candidate: dict[str, Any]) -> bool:
    alignment = candidate.get("alignment") or {}
    return (
        candidate.get("policy") == "AUTO_SELECT"
        and candidate.get("riskStatus") == "RESOLVED"
        and not candidate.get("conflict", False)
        and not alignment.get("unresolved", False)
        and bool(alignment.get("polygons"))
    )


def seed_auto_review(runner, port: int, batch_id: str, document: dict[str, Any], regions: dict[str, Any]) -> int:
    candidates = [
        candidate
        for candidate in regions.get("piiCandidates", [])
        if eligible_candidate(candidate)
    ]
    selected = 0
    for page in regions.get("pages", []):
        for region in page.get("regions", []):
            if (
                region.get("selectionState") != "SELECTED"
                or region.get("selectionSource") != "PII_AUTO"
            ):
                continue
            region_tokens = set(region.get("tokenIds") or [])
            matches = [
                candidate
                for candidate in candidates
                if region_tokens.intersection(candidate.get("tokenIds") or [])
            ]
            if not matches:
                continue
            candidate = max(
                matches,
                key=lambda item: float(item.get("overallConfidence") or 0.0),
            )
            box = auto_box(region, candidate)
            if box is None:
                continue
            runner.request_json(
                port,
                "POST",
                f"/api/v1/medical-redact/batches/{batch_id}/review-actions",
                body=json.dumps(
                    {
                        "documentId": document["id"],
                        "targetType": "TEXT_REGION",
                        "targetId": region["id"],
                        "action": "SELECT_TEXT",
                        "before": None,
                        "after": {
                            "entityType": candidate.get("entityType") or "OTHER",
                            "entityRole": candidate.get("entityRole"),
                            "box": box,
                            "selectionState": "SELECTED",
                            "selectionSource": "PII_AUTO",
                        },
                    },
                    ensure_ascii=False,
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                timeout=60,
            )
            selected += 1
    return selected


def latest_report(batch: dict[str, Any], document_id: str) -> dict[str, Any] | None:
    for report in reversed(batch.get("verificationReports", [])):
        if report.get("documentId") == document_id:
            return report
    return None


def add_manual_boxes_for_findings(
    runner,
    port: int,
    batch_id: str,
    document: dict[str, Any],
    report: dict[str, Any],
) -> int:
    pages_by_number = {
        int(page["pageNo"]): page for page in document.get("pages", [])
    }
    added = 0
    for index, issue in enumerate(report.get("issues") or [], start=1):
        params = issue.get("params") or {}
        page_no = params.get("pageNo")
        page = pages_by_number.get(int(page_no)) if page_no is not None else None
        required = ("x", "y", "width", "height")
        if page is None or any(params.get(key) is None for key in required):
            continue

        runner.request_json(
            port,
            "POST",
            f"/api/v1/medical-redact/batches/{batch_id}/review-actions",
            body=json.dumps(
                {
                    "documentId": document["id"],
                    "targetType": "MANUAL_RECTANGLE",
                    "targetId": (
                        f"real-sample-remediation-{document['id']}-"
                        f"{report.get('id', 'report')}-{index}"
                    ),
                    "action": "ADD_MANUAL",
                    "before": None,
                    "after": {
                        "entityType": params.get("entityType") or "OTHER",
                        "entityRole": "PATIENT",
                        "box": {
                            "pageId": page["id"],
                            "x": float(params["x"]),
                            "y": float(params["y"]),
                            "width": float(params["width"]),
                            "height": float(params["height"]),
                        },
                        "selectionState": "SELECTED",
                        "selectionSource": "MANUAL_RECTANGLE",
                    },
                },
                ensure_ascii=False,
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
        added += 1
    return added


def main() -> None:
    missing = [str(path) for path in SAMPLES if not path.is_file()]
    if missing:
        raise SystemExit("Missing real medical sample(s): " + ", ".join(missing))

    runner = load_runner()
    shutil.rmtree(runner.E2E_ROOT, ignore_errors=True)
    runner.E2E_ROOT.mkdir(parents=True, exist_ok=True)

    process, java_pid, port, engine_pid, engine_port = runner.start_bundle()
    summary: dict[str, Any] = {
        "springPort": port,
        "enginePort": engine_port,
        "documents": [],
    }
    try:
        batch = runner.request_json(
            port,
            "POST",
            "/api/v1/medical-redact/batches",
            body=json.dumps({"name": "真实样例病历回归", "knownEntities": []}).encode(
                "utf-8"
            ),
            headers={"Content-Type": "application/json"},
        )
        batch_id = batch["id"]

        body, boundary = runner.multipart(SAMPLES)
        imported = runner.request_json(
            port,
            "POST",
            f"/api/v1/medical-redact/batches/{batch_id}/documents",
            body=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            timeout=180,
        )
        if imported.get("documentCount") != len(SAMPLES):
            raise AssertionError(
                f"Expected {len(SAMPLES)} imported documents, got {imported.get('documentCount')}"
            )

        by_name = {
            document["originalFilename"]: document
            for document in imported["documents"]
        }
        for sample in SAMPLES:
            document = by_name.get(sample.name)
            if document is None:
                raise AssertionError(f"Imported sample missing: {sample.name}")
            if document.get("pageCount") != 1:
                raise AssertionError(
                    f"Image sample should produce one review page: {sample.name}"
                )

            review_pdf = runner.request_json(
                port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/review",
                timeout=60,
            )
            if not review_pdf.startswith(b"%PDF"):
                raise AssertionError(f"Review derivative is not PDF: {sample.name}")

            regions = runner.request_json(
                port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/text-regions",
                timeout=180,
            )
            if not regions.get("engineAvailable"):
                raise AssertionError(f"OCR engine unavailable: {sample.name}")
            if not regions.get("pages"):
                raise AssertionError(f"No OCR page result: {sample.name}")
            page = regions["pages"][0]
            if page.get("mode") != "PADDLE_OCR":
                raise AssertionError(
                    f"Unexpected OCR mode for {sample.name}: {page.get('mode')}"
                )
            if not page.get("tokens") or not page.get("regions"):
                raise AssertionError(f"OCR returned no selectable text: {sample.name}")

            candidates = regions.get("piiCandidates") or []
            policy_counts = Counter(
                str(candidate.get("policy") or "UNKNOWN") for candidate in candidates
            )
            risk_counts = Counter(
                str(candidate.get("riskStatus") or "UNKNOWN")
                for candidate in candidates
            )
            entity_types = sorted(
                {
                    str(candidate.get("entityType"))
                    for candidate in candidates
                    if candidate.get("entityType")
                }
            )
            auto_review_actions = seed_auto_review(
                runner, port, batch_id, document, regions
            )

            verified = runner.request_json(
                port,
                "POST",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/finalize",
                body=b"{}",
                headers={"Content-Type": "application/json"},
                timeout=180,
            )
            verified_report = latest_report(verified, document["id"])
            if verified_report is None:
                raise AssertionError(f"Missing verification report: {sample.name}")

            remediation_boxes = 0
            remediation_rounds = 0
            remediated_report = verified_report
            while (
                remediated_report is not None
                and remediated_report.get("status") == "BLOCKED"
                and remediation_rounds < 5
            ):
                added = add_manual_boxes_for_findings(
                    runner, port, batch_id, document, remediated_report
                )
                if added == 0:
                    raise AssertionError(
                        f"Blocked verification exposed no actionable boxes: {sample.name}"
                    )
                remediation_boxes += added
                remediation_rounds += 1
                remediated = runner.request_json(
                    port,
                    "POST",
                    f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/finalize",
                    body=b"{}",
                    headers={"Content-Type": "application/json"},
                    timeout=180,
                )
                remediated_report = latest_report(remediated, document["id"])

            if (
                remediated_report is None
                or remediated_report.get("status") != "PASS"
            ):
                raise AssertionError(
                    f"Manual remediation did not clear verification within "
                    f"{remediation_rounds} rounds: {sample.name}: {remediated_report}"
                )

            generated = runner.request_json(
                port,
                "POST",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/finalize?verify=false",
                body=b"{}",
                headers={"Content-Type": "application/json"},
                timeout=180,
            )
            generated_report = latest_report(generated, document["id"])
            if generated_report is None or generated_report.get("status") != "SKIPPED":
                raise AssertionError(
                    f"Verification-disabled generation failed: {sample.name}: {generated_report}"
                )
            output = runner.request_json(
                port,
                "GET",
                f"/api/v1/medical-redact/batches/{batch_id}/documents/{document['id']}/output",
                timeout=60,
            )
            output_check = runner.assert_secure_output(output, 1, sample.name)

            summary["documents"].append(
                {
                    "filename": sample.name,
                    "sourceBytes": sample.stat().st_size,
                    "ocrElapsedMs": page.get("elapsedMs"),
                    "warningCode": page.get("warningCode"),
                    "tokenCount": len(page.get("tokens") or []),
                    "regionCount": len(page.get("regions") or []),
                    "piiAvailable": bool(regions.get("piiAvailable")),
                    "piiCandidateCount": len(candidates),
                    "piiPolicies": dict(sorted(policy_counts.items())),
                    "piiRiskStatus": dict(sorted(risk_counts.items())),
                    "piiEntityTypes": entity_types,
                    "autoReviewActions": auto_review_actions,
                    "verificationStatusAfterAuto": verified_report.get("status"),
                    "verificationFindingCountAfterAuto": verified_report.get(
                        "findingCount"
                    ),
                    "verificationFindingCodesAfterAuto": verified_report.get(
                        "findingCodes"
                    )
                    or [
                        issue.get("code")
                        for issue in verified_report.get("issues", [])
                        if issue.get("code")
                    ],
                    "manualRemediationRounds": remediation_rounds,
                    "manualRemediationBoxes": remediation_boxes,
                    "verificationStatusAfterManualRemediation": remediated_report.get(
                        "status"
                    ),
                    "generatedStatusWithVerificationDisabled": generated_report.get(
                        "status"
                    ),
                    "outputBytes": output_check["bytes"],
                    "outputPages": output_check["pages"],
                }
            )

        runner.request_json(
            port,
            "POST",
            "/api/v1/medical-redact/workspace/cleanup-temp",
            body=b"{}",
            headers={"Content-Type": "application/json"},
        )
    finally:
        runner.stop_bundle(process)

    runner.RESULT.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Real medical sample E2E passed")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
