from __future__ import annotations

import hashlib

from stirling.contracts.medical_redact import (
    SelectableTextRegion,
    SelectionSource,
    SelectionState,
    TextToken,
)


def build_selectable_regions(
    document_id: str,
    page_id: str,
    tokens: list[TextToken],
) -> list[SelectableTextRegion]:
    regions: list[SelectableTextRegion] = []
    for token in tokens:
        if token.page_id != page_id:
            continue
        digest = hashlib.sha256(f"{document_id}|{page_id}|{token.id}".encode()).hexdigest()[:20]
        regions.append(
            SelectableTextRegion(
                id=f"region-{digest}",
                document_id=document_id,
                page_id=page_id,
                token_ids=[token.id],
                polygon=token.polygon,
                source=token.source,
                confidence=token.confidence,
                selection_state=SelectionState.UNSELECTED,
                selection_source=SelectionSource.NONE,
            )
        )
    return regions
