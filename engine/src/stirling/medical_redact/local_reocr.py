from __future__ import annotations

import base64
import binascii
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

import cv2
import numpy as np

from stirling.contracts.medical_redact import (
    AlignmentLevel,
    AlignmentPolygon,
    CandidateAlignment,
    CharacterBox,
    OCRRequest,
    PolygonPoint,
    TextToken,
)
from stirling.medical_redact.ocr import OcrService

_LOCAL_REOCR_SCALE = 3.0
_LOCAL_REOCR_MARGIN_RATIO = 0.55
_FUZZY_MIN_RATIO = 0.80


@dataclass(frozen=True)
class _AlignedCharacter:
    value: str
    polygon: list[PolygonPoint]
    line_id: str


def _bounds(points: list[PolygonPoint]) -> tuple[float, float, float, float] | None:
    if len(points) < 4:
        return None
    xs = [point.x for point in points]
    ys = [point.y for point in points]
    if not all(np.isfinite(value) for value in (*xs, *ys)):
        return None
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _unresolved(code: str, *extra: str) -> CandidateAlignment:
    return CandidateAlignment(
        level=AlignmentLevel.D,
        confidence=0.0,
        method="LOCAL_REOCR_FAILED",
        warnings=[code, *extra],
        needs_local_reocr=False,
        unresolved=True,
    )


def _normalized_chars(value: str) -> list[str]:
    result: list[str] = []
    for source in value:
        for char in unicodedata.normalize("NFKC", source):
            if not char.isspace():
                result.append(char.upper())
    return result


def _append_character_box(
    result: list[_AlignedCharacter],
    character: CharacterBox,
    line_id: str,
    offset_x: float,
    offset_y: float,
) -> None:
    values = _normalized_chars(character.text)
    if not values:
        return
    shifted = [PolygonPoint(x=point.x + offset_x, y=point.y + offset_y) for point in character.polygon]
    for value in values:
        result.append(_AlignedCharacter(value=value, polygon=shifted, line_id=line_id))


def _flatten_characters(
    tokens: list[TextToken],
    offset_x: float,
    offset_y: float,
) -> list[_AlignedCharacter]:
    result: list[_AlignedCharacter] = []
    for token in tokens:
        if not token.char_boxes:
            continue
        line_id = token.line_id or token.id
        for character in token.char_boxes:
            _append_character_box(result, character, line_id, offset_x, offset_y)
    return result


def _best_match(target: str, haystack: str) -> tuple[int, int, float] | None:
    if not target or not haystack:
        return None
    exact = haystack.find(target)
    if exact >= 0:
        return exact, exact + len(target), 1.0

    minimum = max(1, len(target) - 2)
    maximum = min(len(haystack), len(target) + 2)
    best: tuple[int, int, float] | None = None
    for width in range(minimum, maximum + 1):
        for start in range(0, len(haystack) - width + 1):
            end = start + width
            ratio = SequenceMatcher(None, target, haystack[start:end]).ratio()
            if best is None or ratio > best[2]:
                best = (start, end, ratio)
    if best is None or best[2] < _FUZZY_MIN_RATIO:
        return None
    return best


def _union(points: list[list[PolygonPoint]], page_width: float, page_height: float) -> list[PolygonPoint] | None:
    boxes = [box for polygon in points if (box := _bounds(polygon)) is not None]
    if not boxes:
        return None
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    glyph_height = max(1.0, bottom - top)
    margin_x = max(2.0, glyph_height * 0.08)
    margin_y = max(2.0, glyph_height * 0.05)
    left = max(0.0, left - margin_x)
    top = max(0.0, top - margin_y)
    right = min(page_width, right + margin_x)
    bottom = min(page_height, bottom + margin_y)
    if right <= left or bottom <= top:
        return None
    return [
        PolygonPoint(x=left, y=top),
        PolygonPoint(x=right, y=top),
        PolygonPoint(x=right, y=bottom),
        PolygonPoint(x=left, y=bottom),
    ]


def _matched_polygons(
    characters: list[_AlignedCharacter],
    start: int,
    end: int,
    page_id: str,
    page_width: float,
    page_height: float,
) -> list[AlignmentPolygon]:
    grouped: dict[str, list[list[PolygonPoint]]] = {}
    for character in characters[start:end]:
        grouped.setdefault(character.line_id, []).append(character.polygon)
    result: list[AlignmentPolygon] = []
    for polygons in grouped.values():
        union = _union(polygons, page_width, page_height)
        if union is not None:
            result.append(AlignmentPolygon(page_id=page_id, points=union))
    return result


def refine_candidate_alignment(
    *,
    target_text: str,
    alignment: CandidateAlignment,
    page_image: OCRRequest,
    ocr_service: OcrService,
) -> CandidateAlignment:
    if not alignment.polygons:
        return _unresolved("LOCAL_REOCR_MISSING_BBOX")
    if any(polygon.page_id != page_image.page_id for polygon in alignment.polygons):
        return _unresolved("LOCAL_REOCR_PAGE_MISMATCH")

    source_boxes = [box for polygon in alignment.polygons if (box := _bounds(polygon.points)) is not None]
    if len(source_boxes) != len(alignment.polygons):
        return _unresolved("LOCAL_REOCR_INVALID_BBOX")

    left = min(box[0] for box in source_boxes)
    top = min(box[1] for box in source_boxes)
    right = max(box[2] for box in source_boxes)
    bottom = max(box[3] for box in source_boxes)
    if (
        left < 0
        or top < 0
        or right > page_image.page_width
        or bottom > page_image.page_height
        or right <= left
        or bottom <= top
    ):
        return _unresolved("BBOX_OUT_OF_BOUNDS")

    try:
        image_bytes = base64.b64decode(page_image.image_base64, validate=True)
        decoded = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    except (binascii.Error, ValueError):
        decoded = None
    if decoded is None:
        return _unresolved("LOCAL_REOCR_IMAGE_DECODE_FAILED")

    render_height, render_width = decoded.shape[:2]
    if render_width != page_image.render_width or render_height != page_image.render_height:
        return _unresolved("LOCAL_REOCR_IMAGE_DIMENSION_MISMATCH")

    margin = max(4.0, (bottom - top) * _LOCAL_REOCR_MARGIN_RATIO)
    crop_left = max(0.0, left - margin)
    crop_top = max(0.0, top - margin)
    crop_right = min(page_image.page_width, right + margin)
    crop_bottom = min(page_image.page_height, bottom + margin)
    if crop_right <= crop_left or crop_bottom <= crop_top:
        return _unresolved("LOCAL_REOCR_INVALID_CROP")

    scale_x = render_width / page_image.page_width
    scale_y = render_height / page_image.page_height
    pixel_left = max(0, int(np.floor(crop_left * scale_x)))
    pixel_top = max(0, int(np.floor(crop_top * scale_y)))
    pixel_right = min(render_width, int(np.ceil(crop_right * scale_x)))
    pixel_bottom = min(render_height, int(np.ceil(crop_bottom * scale_y)))
    if pixel_right <= pixel_left or pixel_bottom <= pixel_top:
        return _unresolved("LOCAL_REOCR_INVALID_CROP")

    crop = decoded[pixel_top:pixel_bottom, pixel_left:pixel_right]
    enlarged = cv2.resize(
        crop,
        None,
        fx=_LOCAL_REOCR_SCALE,
        fy=_LOCAL_REOCR_SCALE,
        interpolation=cv2.INTER_CUBIC,
    )
    encoded, png = cv2.imencode(".png", enlarged)
    if not encoded:
        return _unresolved("LOCAL_REOCR_IMAGE_ENCODE_FAILED")

    crop_request = OCRRequest(
        document_id=page_image.document_id,
        page_id=page_image.page_id,
        page_no=page_image.page_no,
        page_width=crop_right - crop_left,
        page_height=crop_bottom - crop_top,
        render_width=enlarged.shape[1],
        render_height=enlarged.shape[0],
        image_base64=base64.b64encode(png.tobytes()).decode("ascii"),
        mode="LOCAL_REOCR",
    )
    response = ocr_service.recognize(crop_request)
    if not response.available:
        warnings = [response.warning_code] if response.warning_code else []
        return _unresolved("LOCAL_REOCR_UNAVAILABLE", *warnings)
    if not response.tokens:
        return _unresolved("LOCAL_REOCR_NO_TEXT")

    characters = _flatten_characters(response.tokens, crop_left, crop_top)
    local_text = "".join(character.value for character in characters)
    target = "".join(_normalized_chars(target_text))
    match = _best_match(target, local_text)
    if match is None:
        return _unresolved("LOCAL_REOCR_NO_SAFE_MATCH")

    start, end, ratio = match
    polygons = _matched_polygons(
        characters,
        start,
        end,
        page_image.page_id,
        page_image.page_width,
        page_image.page_height,
    )
    if not polygons:
        return _unresolved("LOCAL_REOCR_NO_CHAR_BOX")

    token_confidences = [token.confidence for token in response.tokens if token.confidence is not None]
    ocr_confidence = min(token_confidences) if token_confidences else 1.0
    if ratio == 1.0:
        confidence = min(0.85, ocr_confidence)
        method = "LOCAL_REOCR_EXACT"
        warnings: list[str] = []
    else:
        confidence = min(0.70, ocr_confidence)
        method = "LOCAL_REOCR_FUZZY"
        warnings = ["LOCAL_REOCR_FUZZY_MATCH"]

    return CandidateAlignment(
        level=AlignmentLevel.C,
        confidence=max(0.0, confidence),
        method=method,
        polygons=polygons,
        warnings=warnings,
        needs_local_reocr=False,
        unresolved=False,
    )
