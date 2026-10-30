import { useEffect, useRef } from "react";
import type {
  RedactionDocumentState,
  RedactionItem,
  RedactionScope,
} from "@embedpdf/plugin-redaction";
import { useDocumentReady } from "@app/components/viewer/hooks/useDocumentReady";
import { useViewer } from "@app/contexts/ViewerContext";
import { useAllFiles } from "@app/contexts/FileContext";
import { useMedicalRedactReview } from "@app/contexts/MedicalRedactReviewContext";
import { isStirlingFile } from "@app/types/fileContext";

function geometrySignature(item: RedactionItem) {
  return JSON.stringify(item.rect);
}

export function useMedicalRedactReviewTracking(
  _documentId: string,
  redaction: RedactionScope | null | undefined,
  pending: RedactionDocumentState["pending"] | undefined,
) {
  const documentReady = useDocumentReady();
  const { activeFileId } = useViewer();
  const { files } = useAllFiles();
  const {
    getRestoredRedactions,
    recordGeometryChange,
    recordRedactionEvent,
    sessionRevision,
  } = useMedicalRedactReview();
  const timersRef = useRef(new Map<string, number>());
  const geometrySignaturesRef = useRef(new Map<string, string>());
  const geometryPagesRef = useRef(new Map<string, number>());
  const restoredSessionRef = useRef<string | null>(null);
  const recordRedactionEventRef = useRef(recordRedactionEvent);
  const recordGeometryChangeRef = useRef(recordGeometryChange);
  recordRedactionEventRef.current = recordRedactionEvent;
  recordGeometryChangeRef.current = recordGeometryChange;
  const activeFile = files.find(
    (file) => isStirlingFile(file) && file.fileId === activeFileId,
  );
  const fileKey = activeFile?.name ?? activeFileId;

  useEffect(() => {
    if (
      !documentReady ||
      !redaction ||
      !fileKey ||
      !pending ||
      sessionRevision === 0
    )
      return;
    const restorationKey = `${sessionRevision}:${_documentId}:${fileKey}`;
    if (restoredSessionRef.current === restorationKey) return;
    restoredSessionRef.current = restorationKey;
    const pendingIds = new Set(
      Object.values(pending)
        .flat()
        .map((item) => item.id),
    );
    const restored = getRestoredRedactions(fileKey);
    restored.forEach((item) => {
      geometrySignaturesRef.current.set(item.id, geometrySignature(item));
      geometryPagesRef.current.set(item.id, item.page);
    });
    const missing = restored.filter((item) => !pendingIds.has(item.id));
    if (missing.length > 0) redaction.addPending(missing);
  }, [
    _documentId,
    documentReady,
    fileKey,
    getRestoredRedactions,
    pending,
    redaction,
    sessionRevision,
  ]);

  useEffect(() => {
    if (!redaction || !fileKey) return;
    const timers = timersRef.current;
    const unsubscribeRedaction = redaction.onRedactionEvent((event) => {
      if (event.type === "remove") {
        geometrySignaturesRef.current.delete(event.id);
        geometryPagesRef.current.delete(event.id);
        const pendingTimer = timers.get(event.id);
        if (pendingTimer !== undefined) {
          window.clearTimeout(pendingTimer);
          timers.delete(event.id);
        }
      }
      recordRedactionEventRef.current(fileKey, event);
    });

    return () => {
      unsubscribeRedaction();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      geometrySignaturesRef.current.clear();
      geometryPagesRef.current.clear();
    };
  }, [fileKey, redaction]);

  useEffect(() => {
    if (!fileKey || !pending) return;
    const timers = timersRef.current;
    const items = Object.values(pending).flat();
    const currentIds = new Set(items.map((item) => item.id));

    for (const knownId of [...geometrySignaturesRef.current.keys()]) {
      if (currentIds.has(knownId)) continue;
      const page = geometryPagesRef.current.get(knownId) ?? 0;
      geometrySignaturesRef.current.delete(knownId);
      geometryPagesRef.current.delete(knownId);
      const pendingTimer = timers.get(knownId);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        timers.delete(knownId);
      }
      recordRedactionEventRef.current(fileKey, {
        type: "remove",
        documentId: _documentId,
        page,
        id: knownId,
      });
    }

    items.forEach((item) => {
      geometryPagesRef.current.set(item.id, item.page);
      const signature = geometrySignature(item);
      if (geometrySignaturesRef.current.get(item.id) === signature) return;
      geometrySignaturesRef.current.set(item.id, signature);
      const current = timers.get(item.id);
      if (current !== undefined) window.clearTimeout(current);
      timers.set(
        item.id,
        window.setTimeout(() => {
          timers.delete(item.id);
          recordGeometryChangeRef.current(fileKey, item);
        }, 250),
      );
    });
  }, [_documentId, fileKey, pending]);
}
