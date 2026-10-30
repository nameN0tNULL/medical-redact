from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

from stirling.contracts.medical_redact import (
    AlignmentLevel,
    AlignmentPolygon,
    CandidateAlignment,
    CandidatePolicy,
    CandidateRiskStatus,
    DocumentText,
    NormalizedTextView,
    PolygonPoint,
    TextSource,
    TextToken,
)


class DetectionSource(StrEnum):
    NER = "NER"
    RULE = "RULE"
    KNOWN = "KNOWN"


_SOURCE_PRIORITY = {
    DetectionSource.NER: 1,
    DetectionSource.RULE: 2,
    DetectionSource.KNOWN: 3,
}


@dataclass(frozen=True)
class RawDetection:
    entity_type: str
    entity_role: str | None
    normalized_start: int
    normalized_end: int
    confidence: float
    detector: str
    source: DetectionSource


@dataclass(frozen=True)
class FusedDetection:
    entity_type: str
    entity_role: str | None
    normalized_start: int
    normalized_end: int
    confidence: float
    detector: str
    detector_evidence: tuple[str, ...]
    sources: tuple[DetectionSource, ...]
    conflict: bool = False
    conflict_types: tuple[str, ...] = ()


def _overlap(left: RawDetection | FusedDetection, right: RawDetection | FusedDetection) -> int:
    return max(
        0,
        min(left.normalized_end, right.normalized_end) - max(left.normalized_start, right.normalized_start),
    )


def _best_raw(left: RawDetection, right: RawDetection) -> RawDetection:
    left_key = (_SOURCE_PRIORITY[left.source], left.confidence, -left.normalized_start)
    right_key = (_SOURCE_PRIORITY[right.source], right.confidence, -right.normalized_start)
    return left if left_key >= right_key else right


def _merge_same_type(current: FusedDetection, incoming: RawDetection) -> FusedDetection:
    primary = RawDetection(
        entity_type=current.entity_type,
        entity_role=current.entity_role,
        normalized_start=current.normalized_start,
        normalized_end=current.normalized_end,
        confidence=current.confidence,
        detector=current.detector,
        source=max(current.sources, key=_SOURCE_PRIORITY.__getitem__),
    )
    winner = _best_raw(primary, incoming)
    evidence = tuple(dict.fromkeys((*current.detector_evidence, incoming.detector)))
    sources = tuple(dict.fromkeys((*current.sources, incoming.source)))
    role_conflict = (
        current.entity_role is not None
        and incoming.entity_role is not None
        and current.entity_role != incoming.entity_role
    )
    confidence = max(current.confidence, incoming.confidence)
    if DetectionSource.KNOWN in sources:
        confidence = 1.0
    elif len(evidence) > 1:
        confidence = min(1.0, confidence + 0.02)

    return FusedDetection(
        entity_type=current.entity_type,
        entity_role=winner.entity_role or current.entity_role or incoming.entity_role,
        normalized_start=min(current.normalized_start, incoming.normalized_start),
        normalized_end=max(current.normalized_end, incoming.normalized_end),
        confidence=confidence,
        detector=winner.detector,
        detector_evidence=evidence,
        sources=sources,
        conflict=current.conflict or role_conflict,
        conflict_types=current.conflict_types,
    )


def fuse_detections(detections: list[RawDetection]) -> list[FusedDetection]:
    fused: list[FusedDetection] = []
    for detection in sorted(
        detections,
        key=lambda item: (
            item.normalized_start,
            item.normalized_end,
            -_SOURCE_PRIORITY[item.source],
            -item.confidence,
            item.entity_type,
        ),
    ):
        merged_index: int | None = None
        for index, current in enumerate(fused):
            if current.entity_type != detection.entity_type:
                continue
            if _overlap(current, detection) <= 0:
                continue
            merged_index = index
            break

        if merged_index is None:
            fused.append(
                FusedDetection(
                    entity_type=detection.entity_type,
                    entity_role=detection.entity_role,
                    normalized_start=detection.normalized_start,
                    normalized_end=detection.normalized_end,
                    confidence=detection.confidence,
                    detector=detection.detector,
                    detector_evidence=(detection.detector,),
                    sources=(detection.source,),
                )
            )
        else:
            fused[merged_index] = _merge_same_type(fused[merged_index], detection)

    conflicted = list(fused)
    for left_index, left in enumerate(fused):
        for right_index in range(left_index + 1, len(fused)):
            right = fused[right_index]
            if left.entity_type == right.entity_type or _overlap(left, right) <= 0:
                continue
            left_types = tuple(dict.fromkeys((*conflicted[left_index].conflict_types, right.entity_type)))
            right_types = tuple(dict.fromkeys((*conflicted[right_index].conflict_types, left.entity_type)))
            conflicted[left_index] = replace(conflicted[left_index], conflict=True, conflict_types=left_types)
            conflicted[right_index] = replace(
                conflicted[right_index],
                conflict=True,
                conflict_types=right_types,
            )

    return sorted(
        conflicted,
        key=lambda item: (item.normalized_start, item.normalized_end, item.entity_type),
    )


def normalized_span_to_source(
    detection: FusedDetection,
    normalized: NormalizedTextView,
) -> tuple[int, int] | None:
    if (
        detection.normalized_start < 0
        or detection.normalized_start >= detection.normalized_end
        or detection.normalized_end > len(normalized.normalized_to_source_index)
    ):
        return None
    return (
        normalized.normalized_to_source_index[detection.normalized_start],
        normalized.normalized_to_source_index[detection.normalized_end - 1] + 1,
    )


def _bounds(polygon: list[PolygonPoint]) -> tuple[float, float, float, float] | None:
    if len(polygon) < 4:
        return None
    xs = [point.x for point in polygon]
    ys = [point.y for point in polygon]
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _rect_polygon(
    left: float,
    top: float,
    right: float,
    bottom: float,
) -> list[PolygonPoint]:
    return [
        PolygonPoint(x=left, y=top),
        PolygonPoint(x=right, y=top),
        PolygonPoint(x=right, y=bottom),
        PolygonPoint(x=left, y=bottom),
    ]


def _union_polygons(polygons: list[list[PolygonPoint]], *, expand: bool = True) -> list[PolygonPoint] | None:
    boxes = [box for polygon in polygons if (box := _bounds(polygon)) is not None]
    if not boxes:
        return None
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    if expand:
        glyph_height = max(1.0, bottom - top)
        margin_x = max(2.0, glyph_height * 0.08)
        margin_y = max(2.0, glyph_height * 0.05)
        left = max(0.0, left - margin_x)
        top = max(0.0, top - margin_y)
        right += margin_x
        bottom += margin_y
    return _rect_polygon(left, top, right, bottom)


def _token_confidence(token: TextToken) -> float:
    return 1.0 if token.confidence is None else token.confidence


def _char_polygons(token: TextToken) -> dict[int, list[PolygonPoint]]:
    if not token.char_boxes:
        return {}
    offsets: dict[int, list[PolygonPoint]] = {}
    cursor = 0
    reconstructed: list[str] = []
    for character in token.char_boxes:
        reconstructed.append(character.text)
        for _ in character.text:
            offsets[cursor] = character.polygon
            cursor += 1
    if "".join(reconstructed) != token.text:
        return {}
    return offsets


def _line_polygons(
    token_ids: list[str],
    token_by_id: dict[str, TextToken],
    polygons_by_token: dict[str, list[list[PolygonPoint]]],
) -> list[AlignmentPolygon]:
    grouped: dict[tuple[str, str], list[list[PolygonPoint]]] = {}
    for token_id in token_ids:
        token = token_by_id[token_id]
        key = (token.page_id, token.line_id or token.id)
        grouped.setdefault(key, []).extend(polygons_by_token.get(token_id, []))
    results: list[AlignmentPolygon] = []
    for (page_id, _line_id), polygons in grouped.items():
        union = _union_polygons(polygons)
        if union is not None:
            results.append(AlignmentPolygon(page_id=page_id, points=union))
    return results


def align_detection(
    detection: FusedDetection,
    source_start: int,
    source_end: int,
    document_text: DocumentText,
    tokens: list[TextToken],
) -> tuple[CandidateAlignment, list[str], list[str]]:
    token_by_id = {token.id: token for token in tokens}
    offsets_by_token: dict[str, set[int]] = {}
    page_ids: list[str] = []
    token_ids: list[str] = []

    for entry in document_text.index_map[source_start:source_end]:
        if entry.token_id is None or entry.offset_in_token is None:
            continue
        token = token_by_id.get(entry.token_id)
        if token is None:
            continue
        offsets_by_token.setdefault(token.id, set()).add(entry.offset_in_token)
        if token.id not in token_ids:
            token_ids.append(token.id)
        if token.page_id not in page_ids:
            page_ids.append(token.page_id)

    if not token_ids:
        return (
            CandidateAlignment(
                level=AlignmentLevel.D,
                confidence=0.0,
                method="UNRESOLVED",
                warnings=["NO_SOURCE_TOKEN"],
                unresolved=True,
            ),
            page_ids,
            token_ids,
        )

    if any(_bounds(token_by_id[token_id].polygon) is None for token_id in token_ids):
        return (
            CandidateAlignment(
                level=AlignmentLevel.D,
                confidence=0.0,
                method="UNRESOLVED",
                warnings=["INVALID_TOKEN_POLYGON"],
                unresolved=True,
            ),
            page_ids,
            token_ids,
        )

    full_token_coverage = all(
        offsets_by_token[token_id] == set(range(len(token_by_id[token_id].text))) for token_id in token_ids
    )
    selected_char_polygons: dict[str, list[list[PolygonPoint]]] = {}
    has_all_selected_char_boxes = True
    for token_id in token_ids:
        char_map = _char_polygons(token_by_id[token_id])
        selected: list[list[PolygonPoint]] = []
        for offset in sorted(offsets_by_token[token_id]):
            polygon = char_map.get(offset)
            if polygon is None:
                has_all_selected_char_boxes = False
                break
            selected.append(polygon)
        if selected:
            selected_char_polygons[token_id] = selected

    if has_all_selected_char_boxes and all(
        token_by_id[token_id].source == TextSource.PDF_TEXT for token_id in token_ids
    ):
        polygons = _line_polygons(token_ids, token_by_id, selected_char_polygons)
        return (
            CandidateAlignment(
                level=AlignmentLevel.A,
                confidence=1.0,
                method="PDF_NATIVE_CHAR",
                polygons=polygons,
            ),
            page_ids,
            token_ids,
        )

    if full_token_coverage:
        token_polygons = {token_id: [token_by_id[token_id].polygon] for token_id in token_ids}
        confidence = min(_token_confidence(token_by_id[token_id]) for token_id in token_ids)
        polygons = _line_polygons(token_ids, token_by_id, token_polygons)
        return (
            CandidateAlignment(
                level=AlignmentLevel.B,
                confidence=min(0.98, confidence),
                method="TOKEN_FULL",
                polygons=polygons,
            ),
            page_ids,
            token_ids,
        )

    if has_all_selected_char_boxes:
        confidence = min([_token_confidence(token_by_id[token_id]) for token_id in token_ids] + [0.95])
        polygons = _line_polygons(token_ids, token_by_id, selected_char_polygons)
        return (
            CandidateAlignment(
                level=AlignmentLevel.C,
                confidence=confidence,
                method="OCR_CHAR_BOX",
                polygons=polygons,
            ),
            page_ids,
            token_ids,
        )

    token_polygons = {token_id: [token_by_id[token_id].polygon] for token_id in token_ids}
    polygons = _line_polygons(token_ids, token_by_id, token_polygons)
    coarse_confidence = min([_token_confidence(token_by_id[token_id]) for token_id in token_ids] + [0.65])
    return (
        CandidateAlignment(
            level=AlignmentLevel.C,
            confidence=coarse_confidence,
            method="TOKEN_PARTIAL",
            polygons=polygons,
            warnings=["PARTIAL_TOKEN_NEEDS_REOCR"],
            needs_local_reocr=True,
        ),
        page_ids,
        token_ids,
    )


_KEEP_TYPES = {"HOSPITAL_NAME", "DEPARTMENT_NAME"}
_REVIEW_TYPES = {"DOCTOR_NAME", "FAMILY_MEMBER_NAME"}
_STRONG_AUTO_TYPES = {
    "PATIENT_NAME",
    "CN_ID_CARD",
    "PHONE",
    "FIXED_PHONE",
    "EMAIL",
    "BANK_CARD",
    "DATE_OF_BIRTH",
    "MEDICAL_RECORD_NO",
    "INPATIENT_NO",
    "OUTPATIENT_NO",
    "INSURANCE_NO",
    "PATIENT_ID",
    "EXAM_NO",
    "SAMPLE_NO",
}


def evaluate_policy(
    detection: FusedDetection,
    alignment: CandidateAlignment,
) -> tuple[CandidatePolicy, CandidateRiskStatus]:
    if alignment.unresolved or alignment.level == AlignmentLevel.D:
        return CandidatePolicy.REVIEW, CandidateRiskStatus.UNRESOLVED
    if detection.conflict:
        return CandidatePolicy.REVIEW, CandidateRiskStatus.CONFLICT
    if "LOCAL_REOCR_LIMIT_EXCEEDED" in alignment.warnings:
        return CandidatePolicy.REVIEW, CandidateRiskStatus.HIGH_RISK
    if alignment.needs_local_reocr or alignment.confidence < 0.70:
        return CandidatePolicy.REVIEW, CandidateRiskStatus.REVIEW
    if detection.entity_type in _KEEP_TYPES:
        return CandidatePolicy.KEEP, CandidateRiskStatus.RESOLVED
    if detection.entity_type in _REVIEW_TYPES:
        return CandidatePolicy.REVIEW, CandidateRiskStatus.REVIEW
    if detection.entity_type == "HOME_ADDRESS":
        if detection.confidence >= 0.90 and alignment.confidence >= 0.85:
            return CandidatePolicy.AUTO_SELECT, CandidateRiskStatus.RESOLVED
        return CandidatePolicy.REVIEW, CandidateRiskStatus.REVIEW
    if detection.entity_type in _STRONG_AUTO_TYPES and alignment.confidence >= 0.85:
        return CandidatePolicy.AUTO_SELECT, CandidateRiskStatus.RESOLVED
    return CandidatePolicy.REVIEW, CandidateRiskStatus.REVIEW
