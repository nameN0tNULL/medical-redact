import { useEffect, useState } from "react";
import { useDocumentState } from "@embedpdf/core/react";
import { useAnnotation } from "@embedpdf/plugin-annotation/react";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { useViewer } from "@app/contexts/ViewerContext";
import { isStirlingFile } from "@app/types/fileContext";
import type {
  MedicalRedactPoint,
  MedicalRedactSelectableTextRegion,
} from "@app/services/medicalRedactTaskService";
import type { MedicalRedactPreviewLayerProps } from "@core/components/viewer/MedicalRedactPreviewLayer";
import styles from "@app/components/viewer/MedicalRedactPreviewLayer.module.css";

export type { MedicalRedactPreviewLayerProps } from "@core/components/viewer/MedicalRedactPreviewLayer";

const REGION_RENDER_BATCH = 250;
const REDACTION_PADDING_PAGE_SPACE = 2;

interface RegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function polygonBounds(polygon: MedicalRedactPoint[]): RegionBox | null {
  if (polygon.length < 4) return null;
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom) ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function addRedactionPadding(box: RegionBox): RegionBox {
  return {
    x: box.x - REDACTION_PADDING_PAGE_SPACE,
    y: box.y - REDACTION_PADDING_PAGE_SPACE,
    width: box.width + REDACTION_PADDING_PAGE_SPACE * 2,
    height: box.height + REDACTION_PADDING_PAGE_SPACE * 2,
  };
}

function ClickableTextRegion({
  region,
  fileKey,
  scale,
  selected,
  onToggle,
}: {
  region: MedicalRedactSelectableTextRegion;
  fileKey: string;
  scale: number;
  selected: boolean;
  onToggle: (
    fileId: string,
    targetId: string,
    box: RegionBox & { pageId: string },
    selected: boolean,
  ) => void;
}) {
  const bounds = polygonBounds(region.polygon);
  if (!bounds) return null;
  const visualBounds = selected ? addRedactionPadding(bounds) : bounds;

  return (
    <button
      type="button"
      className={styles.region}
      data-medical-redact-text-region={region.id}
      data-selected={selected}
      data-medical-redact-padding={selected ? REDACTION_PADDING_PAGE_SPACE : 0}
      aria-label={selected ? "取消文字脱敏选择" : "选择文字进行脱敏"}
      style={{
        left: visualBounds.x * scale,
        top: visualBounds.y * scale,
        width: visualBounds.width * scale,
        height: visualBounds.height * scale,
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(
          fileKey,
          region.id,
          { pageId: region.pageId, ...bounds },
          !selected,
        );
      }}
    />
  );
}

function ProgressiveTextRegionLayer({
  regions,
  fileKey,
  scale,
  isTextRegionSelected,
  setTextRegionSelected,
}: {
  regions: MedicalRedactSelectableTextRegion[];
  fileKey: string;
  scale: number;
  isTextRegionSelected: (targetId: string) => boolean;
  setTextRegionSelected: (
    fileId: string,
    targetId: string,
    box: RegionBox & { pageId: string },
    selected: boolean,
  ) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(REGION_RENDER_BATCH, regions.length),
  );

  useEffect(() => {
    setVisibleCount(Math.min(REGION_RENDER_BATCH, regions.length));
    if (regions.length <= REGION_RENDER_BATCH) return;

    let frame = 0;
    const renderNextBatch = () => {
      setVisibleCount((current) => {
        const next = Math.min(current + REGION_RENDER_BATCH, regions.length);
        if (next < regions.length) {
          frame = window.requestAnimationFrame(renderNextBatch);
        }
        return next;
      });
    };
    frame = window.requestAnimationFrame(renderNextBatch);
    return () => window.cancelAnimationFrame(frame);
  }, [regions]);

  return (
    <div
      data-medical-redact-text-layer
      data-medical-redact-region-count={regions.length}
      data-medical-redact-render-batch={REGION_RENDER_BATCH}
      data-medical-redact-rendered-region-count={visibleCount}
      className={styles.layer}
    >
      {regions.slice(0, visibleCount).map((region) => (
        <ClickableTextRegion
          key={region.id}
          region={region}
          fileKey={fileKey}
          scale={scale}
          selected={isTextRegionSelected(region.id)}
          onToggle={setTextRegionSelected}
        />
      ))}
    </div>
  );
}

export function MedicalRedactPreviewLayer({
  documentId,
  pageIndex,
}: MedicalRedactPreviewLayerProps) {
  const {
    ensureTextRegions,
    getDocument,
    getTextRegions,
    getSelectedBoxes,
    isFinalPreview,
    isTextRegionSelected,
    manualRedactMode,
    selectionRevision,
    setTextRegionSelected,
    textRegionRevision,
    verificationFocusBox,
  } = useMedicalRedactReview();
  const { activeFileId } = useViewer();
  const { files } = useAllFiles();
  const documentState = useDocumentState(documentId);
  const { state: annotationState, provides: annotationProvides } =
    useAnnotation(documentId);
  const activeFile = files.find(
    (file) => isStirlingFile(file) && file.fileId === activeFileId,
  );
  const fileKey = activeFile?.name ?? activeFileId;

  useEffect(() => {
    if (fileKey) ensureTextRegions(fileKey);
  }, [ensureTextRegions, fileKey]);

  if (!fileKey) return null;

  const scale = documentState?.scale ?? 1;
  const activeDocument = getDocument(fileKey);
  const pageId = activeDocument?.pages[pageIndex]?.id;
  const focusedBox =
    verificationFocusBox && verificationFocusBox.pageId === pageId
      ? verificationFocusBox
      : null;
  const verificationFocus = focusedBox ? (
    <div
      data-medical-redact-verification-focus
      aria-hidden="true"
      className={styles.verificationFocus}
      style={{
        left: focusedBox.x * scale,
        top: focusedBox.y * scale,
        width: focusedBox.width * scale,
        height: focusedBox.height * scale,
      }}
    />
  ) : null;
  void selectionRevision;
  void textRegionRevision;

  if (isFinalPreview) {
    const boxes = getSelectedBoxes(fileKey, pageIndex);
    return (
      <div
        data-medical-redact-final-preview
        aria-hidden="true"
        className={styles.layer}
      >
        {boxes.map(({ id, box }) => {
          const visualBox = addRedactionPadding(box);
          return (
            <div
              key={id}
              data-medical-redact-preview-box={id}
              data-medical-redact-padding={REDACTION_PADDING_PAGE_SPACE}
              className={styles.finalBox}
              style={{
                left: visualBox.x * scale,
                top: visualBox.y * scale,
                width: visualBox.width * scale,
                height: visualBox.height * scale,
              }}
            />
          );
        })}
      </div>
    );
  }

  if (manualRedactMode) {
    const manualPrefix = "MANUAL_RECTANGLE:";
    const selectedAnnotationIds = new Set(annotationState.selectedUids);
    const manualBoxes = getSelectedBoxes(fileKey, pageIndex).flatMap(
      ({ id, box }) => {
        if (!id.startsWith(manualPrefix)) return [];
        const annotationId = id.slice(manualPrefix.length);
        if (!annotationId || selectedAnnotationIds.has(annotationId)) return [];
        return [{ id, annotationId, box }];
      },
    );

    if (manualBoxes.length === 0 && !verificationFocus) return null;

    return (
      <div className={styles.layer}>
        {manualBoxes.map(({ id, annotationId, box }) => (
          <button
            key={id}
            type="button"
            className={styles.manualHitbox}
            aria-label="编辑手工补框"
            style={{
              left: box.x * scale,
              top: box.y * scale,
              width: box.width * scale,
              height: box.height * scale,
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              annotationProvides?.selectAnnotation(pageIndex, annotationId);
            }}
          />
        ))}
        {verificationFocus}
      </div>
    );
  }

  const regions = getTextRegions(fileKey, pageIndex);
  if (regions.length === 0) {
    return verificationFocus ? (
      <div className={styles.layer}>{verificationFocus}</div>
    ) : null;
  }

  return (
    <>
      <ProgressiveTextRegionLayer
        regions={regions}
        fileKey={fileKey}
        scale={scale}
        isTextRegionSelected={isTextRegionSelected}
        setTextRegionSelected={setTextRegionSelected}
      />
      {verificationFocus ? (
        <div className={styles.layer}>{verificationFocus}</div>
      ) : null}
    </>
  );
}
