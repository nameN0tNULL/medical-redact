from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from stirling.models.base import ApiModel


class TextSource(StrEnum):
    PDF_TEXT = "PDF_TEXT"
    PADDLE_OCR = "PADDLE_OCR"
    LOCAL_REOCR = "LOCAL_REOCR"


class SelectionState(StrEnum):
    UNSELECTED = "UNSELECTED"
    SELECTED = "SELECTED"


class SelectionSource(StrEnum):
    NONE = "NONE"
    USER = "USER"
    PII_AUTO = "PII_AUTO"
    MANUAL_RECTANGLE = "MANUAL_RECTANGLE"


class PolygonPoint(ApiModel):
    x: float
    y: float


class CharacterBox(ApiModel):
    text: str = Field(min_length=1)
    polygon: list[PolygonPoint] = Field(min_length=4)


class TextToken(ApiModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    page_id: str = Field(min_length=1)
    polygon: list[PolygonPoint] = Field(min_length=4)
    confidence: float | None = Field(default=None, ge=0, le=1)
    line_id: str | None = None
    block_id: str | None = None
    source: TextSource
    char_boxes: list[CharacterBox] | None = None


class SelectableTextRegion(ApiModel):
    id: str = Field(min_length=1)
    document_id: str = Field(min_length=1)
    page_id: str = Field(min_length=1)
    token_ids: list[str] = Field(min_length=1)
    polygon: list[PolygonPoint] = Field(min_length=4)
    source: TextSource
    confidence: float | None = Field(default=None, ge=0, le=1)
    selection_state: SelectionState = SelectionState.UNSELECTED
    selection_source: SelectionSource = SelectionSource.NONE


class TextExtractRequest(ApiModel):
    document_id: str = Field(min_length=1)
    page_id: str = Field(min_length=1)
    page_no: int = Field(ge=1)
    page_width: float = Field(gt=0)
    page_height: float = Field(gt=0)


class TextExtractResponse(ApiModel):
    reliable: bool
    tokens: list[TextToken] = Field(default_factory=list)
    elapsed_ms: int = Field(default=0, ge=0)


class OCRRequest(ApiModel):
    document_id: str = Field(min_length=1)
    page_id: str = Field(min_length=1)
    page_no: int = Field(ge=1)
    page_width: float = Field(gt=0)
    page_height: float = Field(gt=0)
    render_width: int = Field(gt=0)
    render_height: int = Field(gt=0)
    image_base64: str = Field(min_length=1)
    mode: str = "STANDARD"


class OCRResponse(ApiModel):
    available: bool
    engine: str
    engine_version: str | None = None
    tokens: list[TextToken] = Field(default_factory=list)
    warning_code: str | None = None
    elapsed_ms: int = Field(default=0, ge=0)


class OCRRuntimeCapabilities(ApiModel):
    available: bool
    selected_runtime: str
    available_runtimes: list[str] = Field(default_factory=list)
    fallback_chain: list[str] = Field(default_factory=list)
    onnx_providers: list[str] = Field(default_factory=list)
    onnxruntime_version: str | None = None
    model_formats: list[str] = Field(default_factory=list)
    warning_code: str | None = None


class SelectableRegionRequest(ApiModel):
    document_id: str = Field(min_length=1)
    page_id: str = Field(min_length=1)
    tokens: list[TextToken] = Field(default_factory=list)


class SelectableRegionResponse(ApiModel):
    regions: list[SelectableTextRegion] = Field(default_factory=list)


class DocumentTextSegment(ApiModel):
    source_start: int = Field(ge=0)
    source_end: int = Field(gt=0)
    page_id: str = Field(min_length=1)
    token_id: str = Field(min_length=1)


class DocumentTextIndexEntry(ApiModel):
    page_id: str | None = None
    token_id: str | None = None
    offset_in_token: int | None = Field(default=None, ge=0)


class DocumentText(ApiModel):
    document_id: str = Field(min_length=1)
    text: str
    segments: list[DocumentTextSegment] = Field(default_factory=list)
    index_map: list[DocumentTextIndexEntry] = Field(default_factory=list)


class NormalizedTextView(ApiModel):
    normalized_text: str
    source_text: str
    normalized_to_source_index: list[int] = Field(default_factory=list)
    source_to_normalized_index: list[int] = Field(default_factory=list)


class KnownEntity(ApiModel):
    entity_type: str = Field(min_length=1)
    value: str = Field(min_length=1)
    entity_role: str | None = None


class CandidatePolicy(StrEnum):
    AUTO_SELECT = "AUTO_SELECT"
    REVIEW = "REVIEW"
    KEEP = "KEEP"


class AlignmentLevel(StrEnum):
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class CandidateRiskStatus(StrEnum):
    RESOLVED = "RESOLVED"
    REVIEW = "REVIEW"
    CONFLICT = "CONFLICT"
    HIGH_RISK = "HIGH_RISK"
    UNRESOLVED = "UNRESOLVED"


class AlignmentPolygon(ApiModel):
    page_id: str = Field(min_length=1)
    points: list[PolygonPoint] = Field(min_length=4)


class CandidateAlignment(ApiModel):
    level: AlignmentLevel
    confidence: float = Field(ge=0, le=1)
    method: str = Field(min_length=1)
    polygons: list[AlignmentPolygon] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    needs_local_reocr: bool = False
    unresolved: bool = False


class PIICandidate(ApiModel):
    id: str = Field(min_length=1)
    entity_type: str = Field(min_length=1)
    entity_role: str | None = None
    normalized_start: int = Field(ge=0)
    normalized_end: int = Field(gt=0)
    source_start: int = Field(ge=0)
    source_end: int = Field(gt=0)
    confidence: float = Field(ge=0, le=1)
    overall_confidence: float = Field(ge=0, le=1)
    detector: str = Field(min_length=1)
    detector_evidence: list[str] = Field(min_length=1)
    page_ids: list[str] = Field(min_length=1)
    token_ids: list[str] = Field(min_length=1)
    alignment: CandidateAlignment
    policy: CandidatePolicy
    risk_status: CandidateRiskStatus
    conflict: bool = False


class PIIDetectRequest(ApiModel):
    document_id: str = Field(min_length=1)
    tokens: list[TextToken] = Field(default_factory=list)
    known_entities: list[KnownEntity] = Field(default_factory=list)
    page_images: list[OCRRequest] = Field(default_factory=list)


class PIIDetectResponse(ApiModel):
    available: bool
    candidates: list[PIICandidate] = Field(default_factory=list)
    warning_code: str | None = None


class AlignmentRequest(ApiModel):
    document_id: str = Field(min_length=1)
    spans: list[PIICandidate] = Field(default_factory=list)
    tokens: list[TextToken] = Field(default_factory=list)


class AlignmentResult(ApiModel):
    candidate_id: str = Field(min_length=1)
    token_ids: list[str] = Field(default_factory=list)
    resolved: bool


class AlignmentResponse(ApiModel):
    results: list[AlignmentResult] = Field(default_factory=list)


class VerificationRequest(ApiModel):
    document_id: str = Field(min_length=1)
    selected_region_ids: list[str] = Field(default_factory=list)


class VerificationResponse(ApiModel):
    passed: bool
    finding_codes: list[str] = Field(default_factory=list)
