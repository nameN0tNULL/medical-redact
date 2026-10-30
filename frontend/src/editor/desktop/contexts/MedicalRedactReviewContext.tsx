import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RedactionEvent, RedactionItem } from "@embedpdf/plugin-redaction";
import {
  downloadMedicalRedactOutput,
  finalizeMedicalRedactDocument,
  loadMedicalRedactTextRegions,
  saveMedicalRedactReviewAction,
  type MedicalRedactBatch,
  type MedicalRedactBox,
  type MedicalRedactDocument,
  type MedicalRedactDocumentTextRegions,
  type MedicalRedactPiiCandidate,
  type MedicalRedactReviewActionInput,
  type MedicalRedactReviewState,
  type MedicalRedactReviewTargetType,
  type MedicalRedactSelectableTextRegion,
  type MedicalRedactVerificationReport,
} from "@app/services/medicalRedactTaskService";
import { downloadFile } from "@app/services/downloadService";
import { isMedicalRedactSecurityVerificationEnabled } from "@app/services/medicalRedactPreferences";
import {
  MEDICAL_REDACT_ENTITY_TYPE_OPTIONS,
  medicalRedactUserErrorMessage,
  medicalRedactVerificationMessages,
} from "@app/utils/medicalRedactUiLabels";

const DEFAULT_ENTITY_TYPE = "OTHER";

interface ReviewTargetState {
  documentId: string;
  targetType: MedicalRedactReviewTargetType;
  state: MedicalRedactReviewState;
}

interface SelectedBox {
  id: string;
  box: MedicalRedactBox;
}

export interface MedicalRedactSelectionSummary {
  total: number;
  auto: number;
  user: number;
  manual: number;
}

export type MedicalRedactCandidateDecision = "APPROVE" | "REJECT";

interface TextSelectionHistoryEntry {
  fileId: string;
  targetId: string;
  before: MedicalRedactReviewState | null;
  after: MedicalRedactReviewState;
}

interface ManualReviewHistoryEntry {
  fileId: string;
  targetId: string;
  before: MedicalRedactReviewState | null;
  after: MedicalRedactReviewState | null;
  action: "ADD_MANUAL" | "DELETE_MANUAL" | "MOVE" | "RESIZE" | "CHANGE_TYPE";
}

interface MedicalRedactReviewContextValue {
  entityTypes: typeof MEDICAL_REDACT_ENTITY_TYPE_OPTIONS;
  batch: MedicalRedactBatch | null;
  error: string | null;
  isFinalPreview: boolean;
  manualRedactMode: boolean;
  verificationFocusBox: MedicalRedactBox | null;
  sessionRevision: number;
  selectionRevision: number;
  textRegionRevision: number;
  autoRedactingFileKey: string | null;
  finalizingFileKey: string | null;
  exportingFileKey: string | null;
  canUndoTextSelection: boolean;
  canRedoTextSelection: boolean;
  canUndoManualReview: boolean;
  canRedoManualReview: boolean;
  setFinalPreview: (enabled: boolean) => void;
  setManualRedactMode: (enabled: boolean) => void;
  setVerificationFocusBox: (box: MedicalRedactBox | null) => void;
  startSession: (batch: MedicalRedactBatch, files: File[]) => void;
  getRestoredRedactions: (fileId: string) => RedactionItem[];
  recordRedactionEvent: (fileId: string, event: RedactionEvent) => void;
  recordGeometryChange: (fileId: string, item: RedactionItem) => void;
  ensureTextRegions: (fileId: string) => void;
  autoRedactDocument: (fileId: string) => Promise<void>;
  getTextRegions: (
    fileId: string,
    pageIndex: number,
  ) => MedicalRedactSelectableTextRegion[];
  isTextRegionSelected: (targetId: string) => boolean;
  setTextRegionSelected: (
    fileId: string,
    targetId: string,
    box: MedicalRedactBox,
    selected: boolean,
    entityType?: string | null,
  ) => void;
  undoTextSelection: () => void;
  redoTextSelection: () => void;
  undoManualReview: () => void;
  redoManualReview: () => void;
  getTargetEntityType: (
    targetType: MedicalRedactReviewTargetType,
    targetId: string,
  ) => string;
  changeEntityType: (
    fileId: string,
    targetType: MedicalRedactReviewTargetType,
    targetId: string,
    value: string,
  ) => void;
  getDocument: (fileId: string) => MedicalRedactDocument | undefined;
  getPiiCandidates: (fileId: string) => MedicalRedactPiiCandidate[];
  getCandidateReviewState: (
    fileId: string,
    candidateId: string,
  ) => MedicalRedactReviewState | null;
  getCandidateDecision: (
    fileId: string,
    candidateId: string,
  ) => MedicalRedactCandidateDecision | null;
  reviewCandidate: (
    fileId: string,
    candidateId: string,
    decision: MedicalRedactCandidateDecision,
  ) => void;
  changeCandidateType: (
    fileId: string,
    candidateId: string,
    entityType: string,
  ) => void;
  changeCandidateRole: (
    fileId: string,
    candidateId: string,
    entityRole: string | null,
  ) => void;
  getSelectedCount: (fileId: string) => number;
  getSelectionSummary: (fileId: string) => MedicalRedactSelectionSummary;
  getSelectedBoxes: (fileId: string, pageIndex: number) => SelectedBox[];
  getVerificationReport: (
    fileId: string,
  ) => MedicalRedactVerificationReport | null;
  finalizeDocument: (fileId: string) => Promise<void>;
  exportVerifiedDocument: (fileId: string) => Promise<void>;
}

const MedicalRedactReviewContext =
  createContext<MedicalRedactReviewContextValue | null>(null);

function statesMatch(
  first: MedicalRedactReviewState,
  second: MedicalRedactReviewState,
) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function targetKey(
  targetType: MedicalRedactReviewTargetType,
  targetId: string,
) {
  return `${targetType}:${targetId}`;
}

function isSelected(state: MedicalRedactReviewState | null | undefined) {
  return state?.selectionState === "SELECTED" && state.box !== null;
}

function boxForRegion(
  region: MedicalRedactSelectableTextRegion,
): MedicalRedactBox | null {
  if (region.polygon.length < 4) return null;
  const xs = region.polygon.map((point) => point.x);
  const ys = region.polygon.map((point) => point.y);
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
  return {
    pageId: region.pageId,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function boxForAutoCandidate(
  region: MedicalRedactSelectableTextRegion,
  candidate: MedicalRedactPiiCandidate,
): MedicalRedactBox | null {
  const regionBox = boxForRegion(region);
  if (!regionBox) return null;

  const intersections = candidate.alignment.polygons
    .filter((polygon) => polygon.pageId === region.pageId)
    .map((polygon) => {
      if (polygon.points.length < 4) return null;
      const xs = polygon.points.map((point) => point.x);
      const ys = polygon.points.map((point) => point.y);
      const left = Math.max(regionBox.x, Math.min(...xs));
      const top = Math.max(regionBox.y, Math.min(...ys));
      const right = Math.min(regionBox.x + regionBox.width, Math.max(...xs));
      const bottom = Math.min(regionBox.y + regionBox.height, Math.max(...ys));
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
      return { left, top, right, bottom };
    })
    .filter(
      (
        value,
      ): value is {
        left: number;
        top: number;
        right: number;
        bottom: number;
      } => value !== null,
    );

  if (intersections.length === 0) return null;
  const left = Math.min(...intersections.map((item) => item.left));
  const top = Math.min(...intersections.map((item) => item.top));
  const right = Math.max(...intersections.map((item) => item.right));
  const bottom = Math.max(...intersections.map((item) => item.bottom));
  return {
    pageId: region.pageId,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function MedicalRedactReviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const batchRef = useRef<MedicalRedactBatch | null>(null);
  const documentsByFileIdRef = useRef(new Map<string, MedicalRedactDocument>());
  const documentsByFilenameRef = useRef(
    new Map<string, MedicalRedactDocument>(),
  );
  const targetsRef = useRef(new Map<string, ReviewTargetState>());
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const textRegionsByDocumentRef = useRef(
    new Map<string, MedicalRedactDocumentTextRegions>(),
  );
  const loadingTextRegionsRef = useRef(
    new Map<string, Promise<MedicalRedactDocumentTextRegions>>(),
  );
  const reviewedTextTargetsRef = useRef(new Set<string>());
  const textUndoStackRef = useRef<TextSelectionHistoryEntry[]>([]);
  const textRedoStackRef = useRef<TextSelectionHistoryEntry[]>([]);
  const manualUndoStackRef = useRef<ManualReviewHistoryEntry[]>([]);
  const manualRedoStackRef = useRef<ManualReviewHistoryEntry[]>([]);
  const [targetEntityTypes, setTargetEntityTypes] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [isFinalPreview, setFinalPreview] = useState(false);
  const [manualRedactMode, setManualRedactMode] = useState(false);
  const [verificationFocusBox, setVerificationFocusBox] =
    useState<MedicalRedactBox | null>(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [textRegionRevision, setTextRegionRevision] = useState(0);
  const [textHistoryRevision, setTextHistoryRevision] = useState(0);
  const [manualHistoryRevision, setManualHistoryRevision] = useState(0);
  const [batchSnapshot, setBatchSnapshot] = useState<MedicalRedactBatch | null>(
    null,
  );
  const [autoRedactingFileKey, setAutoRedactingFileKey] = useState<
    string | null
  >(null);
  const [finalizingFileKey, setFinalizingFileKey] = useState<string | null>(
    null,
  );
  const [exportingFileKey, setExportingFileKey] = useState<string | null>(null);

  const documentForFile = useCallback((fileKey: string) => {
    return (
      documentsByFileIdRef.current.get(fileKey) ??
      documentsByFilenameRef.current.get(fileKey)
    );
  }, []);

  const startSession = useCallback(
    (batch: MedicalRedactBatch, files: File[]) => {
      const documentsByFileId = new Map<string, MedicalRedactDocument>();
      const documentsByFilename = new Map<string, MedicalRedactDocument>();
      files.forEach((file, index) => {
        const fileId = (file as File & { fileId?: string }).fileId;
        const document = batch.documents[index];
        if (document) {
          if (fileId) documentsByFileId.set(fileId, document);
          documentsByFilename.set(file.name, document);
        }
      });

      batchRef.current = batch;
      setBatchSnapshot(batch);
      documentsByFileIdRef.current = documentsByFileId;
      documentsByFilenameRef.current = documentsByFilename;
      targetsRef.current.clear();
      queuesRef.current.clear();
      textRegionsByDocumentRef.current.clear();
      loadingTextRegionsRef.current.clear();
      reviewedTextTargetsRef.current.clear();
      textUndoStackRef.current = [];
      textRedoStackRef.current = [];
      manualUndoStackRef.current = [];
      manualRedoStackRef.current = [];
      setTextHistoryRevision((current) => current + 1);
      setManualHistoryRevision((current) => current + 1);

      const restoredTypes: Record<string, string> = {};
      batch.reviewActions.forEach((action) => {
        if (action.targetType === "TEXT_REGION") {
          reviewedTextTargetsRef.current.add(action.targetId);
        }
        const key = targetKey(action.targetType, action.targetId);
        const after = action.after;
        if (
          action.action === "DELETE_MANUAL" ||
          action.action === "DESELECT_TEXT" ||
          action.action === "REJECT" ||
          !after ||
          !isSelected(after)
        ) {
          targetsRef.current.delete(key);
          delete restoredTypes[key];
          return;
        }

        targetsRef.current.set(key, {
          documentId: action.documentId,
          targetType: action.targetType,
          state: after,
        });
        restoredTypes[key] = after.entityType ?? DEFAULT_ENTITY_TYPE;
      });

      setTargetEntityTypes(restoredTypes);
      setError(null);
      setFinalPreview(false);
      setManualRedactMode(false);
      setVerificationFocusBox(null);
      setSelectionRevision((current) => current + 1);
      setTextRegionRevision((current) => current + 1);
      setSessionRevision((current) => current + 1);
    },
    [],
  );

  const enqueueAction = useCallback(
    (key: string, action: MedicalRedactReviewActionInput) => {
      const batch = batchRef.current;
      if (!batch) return;

      const previous = queuesRef.current.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const currentBatch = batchRef.current;
          if (!currentBatch) return;
          const updated = await saveMedicalRedactReviewAction(
            currentBatch.id,
            action,
          );
          batchRef.current = updated;
          setBatchSnapshot(updated);
          setError(null);
        })
        .catch((reason: unknown) => {
          setError(
            medicalRedactUserErrorMessage(reason, "审核记录保存失败，请重试。"),
          );
        });
      queuesRef.current.set(key, next);
    },
    [],
  );

  const pushManualHistory = useCallback((entry: ManualReviewHistoryEntry) => {
    manualUndoStackRef.current.push(entry);
    manualRedoStackRef.current = [];
    setManualHistoryRevision((current) => current + 1);
  }, []);

  const stateForManualItem = useCallback(
    (
      document: MedicalRedactDocument,
      item: RedactionItem,
      entityType: string,
    ): MedicalRedactReviewState | null => {
      const page = document.pages[item.page];
      if (!page) return null;
      return {
        entityType,
        entityRole: entityType === "PATIENT_NAME" ? "PATIENT" : null,
        box: {
          pageId: page.id,
          x: item.rect.origin.x,
          y: item.rect.origin.y,
          width: item.rect.size.width,
          height: item.rect.size.height,
        },
        selectionState: "SELECTED",
        selectionSource: "MANUAL_RECTANGLE",
      };
    },
    [],
  );

  const getRestoredRedactions = useCallback(
    (fileId: string): RedactionItem[] => {
      const document = documentForFile(fileId);
      if (!document) return [];

      return Array.from(targetsRef.current.entries()).flatMap(
        ([key, target]) => {
          const box = target.state.box;
          if (
            target.documentId !== document.id ||
            target.targetType !== "MANUAL_RECTANGLE" ||
            !isSelected(target.state) ||
            !box
          ) {
            return [];
          }
          const pageIndex = document.pages.findIndex(
            (page) => page.id === box.pageId,
          );
          if (pageIndex < 0) return [];
          const targetId = key.slice("MANUAL_RECTANGLE:".length);
          return [
            {
              id: targetId,
              page: pageIndex,
              kind: "area",
              source: "annotation",
              markColor: "#FF0000",
              redactionColor: "#000000",
              rect: {
                origin: { x: box.x, y: box.y },
                size: { width: box.width, height: box.height },
              },
            },
          ];
        },
      );
    },
    [documentForFile],
  );

  const recordRedactionEvent = useCallback(
    (fileId: string, event: RedactionEvent) => {
      const document = documentForFile(fileId);
      if (!document) return;

      if (event.type === "add") {
        event.items.forEach((item) => {
          const key = targetKey("MANUAL_RECTANGLE", item.id);
          if (targetsRef.current.has(key)) return;
          const entityType = targetEntityTypes[key] ?? DEFAULT_ENTITY_TYPE;
          const after = stateForManualItem(document, item, entityType);
          if (!after) return;

          targetsRef.current.set(key, {
            documentId: document.id,
            targetType: "MANUAL_RECTANGLE",
            state: after,
          });
          setTargetEntityTypes((current) => ({
            ...current,
            [key]: entityType,
          }));
          setSelectionRevision((current) => current + 1);
          enqueueAction(key, {
            documentId: document.id,
            targetType: "MANUAL_RECTANGLE",
            targetId: item.id,
            action: "ADD_MANUAL",
            before: null,
            after,
          });
          pushManualHistory({
            fileId,
            targetId: item.id,
            before: null,
            after,
            action: "ADD_MANUAL",
          });
        });
        return;
      }

      if (event.type === "remove") {
        const key = targetKey("MANUAL_RECTANGLE", event.id);
        const target = targetsRef.current.get(key);
        if (!target) return;
        enqueueAction(key, {
          documentId: target.documentId,
          targetType: "MANUAL_RECTANGLE",
          targetId: event.id,
          action: "DELETE_MANUAL",
          before: target.state,
          after: null,
        });
        pushManualHistory({
          fileId,
          targetId: event.id,
          before: target.state,
          after: null,
          action: "DELETE_MANUAL",
        });
        targetsRef.current.delete(key);
        setTargetEntityTypes((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        setSelectionRevision((current) => current + 1);
      }
    },
    [
      documentForFile,
      enqueueAction,
      pushManualHistory,
      stateForManualItem,
      targetEntityTypes,
    ],
  );

  const recordGeometryChange = useCallback(
    (fileId: string, item: RedactionItem) => {
      const document = documentForFile(fileId);
      if (!document) return;

      const key = targetKey("MANUAL_RECTANGLE", item.id);
      const target = targetsRef.current.get(key);
      if (!target) {
        const after = stateForManualItem(
          document,
          item,
          targetEntityTypes[key] ?? DEFAULT_ENTITY_TYPE,
        );
        if (!after) return;
        targetsRef.current.set(key, {
          documentId: document.id,
          targetType: "MANUAL_RECTANGLE",
          state: after,
        });
        setTargetEntityTypes((current) => ({
          ...current,
          [key]: after.entityType ?? DEFAULT_ENTITY_TYPE,
        }));
        setSelectionRevision((current) => current + 1);
        enqueueAction(key, {
          documentId: document.id,
          targetType: "MANUAL_RECTANGLE",
          targetId: item.id,
          action: "ADD_MANUAL",
          before: null,
          after,
        });
        pushManualHistory({
          fileId,
          targetId: item.id,
          before: null,
          after,
          action: "ADD_MANUAL",
        });
        return;
      }

      const entityType = target.state.entityType ?? DEFAULT_ENTITY_TYPE;
      const after = stateForManualItem(document, item, entityType);
      if (!after || statesMatch(target.state, after)) return;

      const sizeChanged =
        target.state.box?.width !== after.box?.width ||
        target.state.box?.height !== after.box?.height;
      const before = target.state;
      targetsRef.current.set(key, {
        documentId: document.id,
        targetType: "MANUAL_RECTANGLE",
        state: after,
      });
      setSelectionRevision((current) => current + 1);
      const action = sizeChanged ? "RESIZE" : "MOVE";
      enqueueAction(key, {
        documentId: document.id,
        targetType: "MANUAL_RECTANGLE",
        targetId: item.id,
        action,
        before,
        after,
      });
      pushManualHistory({
        fileId,
        targetId: item.id,
        before,
        after,
        action,
      });
    },
    [
      documentForFile,
      enqueueAction,
      pushManualHistory,
      stateForManualItem,
      targetEntityTypes,
    ],
  );

  const applyManualHistoryState = useCallback(
    (
      entry: ManualReviewHistoryEntry,
      desired: MedicalRedactReviewState | null,
    ) => {
      const document = documentForFile(entry.fileId);
      if (!document) return;

      const key = targetKey("MANUAL_RECTANGLE", entry.targetId);
      const current = targetsRef.current.get(key)?.state ?? null;
      let action: ManualReviewHistoryEntry["action"];
      if (!desired) {
        action = "DELETE_MANUAL";
        targetsRef.current.delete(key);
        setTargetEntityTypes((types) => {
          const next = { ...types };
          delete next[key];
          return next;
        });
      } else {
        if (!current) {
          action = "ADD_MANUAL";
        } else if (current.entityType !== desired.entityType) {
          action = "CHANGE_TYPE";
        } else if (
          current.box?.width !== desired.box?.width ||
          current.box?.height !== desired.box?.height
        ) {
          action = "RESIZE";
        } else {
          action = "MOVE";
        }
        targetsRef.current.set(key, {
          documentId: document.id,
          targetType: "MANUAL_RECTANGLE",
          state: desired,
        });
        setTargetEntityTypes((types) => ({
          ...types,
          [key]: desired.entityType ?? DEFAULT_ENTITY_TYPE,
        }));
      }

      setSelectionRevision((currentRevision) => currentRevision + 1);
      enqueueAction(key, {
        documentId: document.id,
        targetType: "MANUAL_RECTANGLE",
        targetId: entry.targetId,
        action,
        before: current,
        after: desired,
      });
    },
    [documentForFile, enqueueAction],
  );

  const undoManualReview = useCallback(() => {
    const entry = manualUndoStackRef.current.pop();
    if (!entry) return;
    manualRedoStackRef.current.push(entry);
    setManualHistoryRevision((current) => current + 1);
    applyManualHistoryState(entry, entry.before);
  }, [applyManualHistoryState]);

  const redoManualReview = useCallback(() => {
    const entry = manualRedoStackRef.current.pop();
    if (!entry) return;
    manualUndoStackRef.current.push(entry);
    setManualHistoryRevision((current) => current + 1);
    applyManualHistoryState(entry, entry.after);
  }, [applyManualHistoryState]);

  const canUndoManualReview = manualUndoStackRef.current.length > 0;
  const canRedoManualReview = manualRedoStackRef.current.length > 0;
  void manualHistoryRevision;

  const seedAutoSelections = useCallback(
    (
      document: MedicalRedactDocument,
      extracted: MedicalRedactDocumentTextRegions,
    ) => {
      const candidatesByToken = new Map<string, MedicalRedactPiiCandidate>();
      (extracted.piiCandidates ?? [])
        .filter(
          (candidate) =>
            candidate.policy === "AUTO_SELECT" &&
            candidate.riskStatus === "RESOLVED" &&
            !candidate.conflict &&
            !candidate.alignment.unresolved &&
            candidate.alignment.polygons.length > 0,
        )
        .forEach((candidate) => {
          candidate.tokenIds.forEach((tokenId) => {
            const current = candidatesByToken.get(tokenId);
            if (
              !current ||
              candidate.overallConfidence > current.overallConfidence
            ) {
              candidatesByToken.set(tokenId, candidate);
            }
          });
        });

      const entityTypes: Record<string, string> = {};
      let changed = false;
      extracted.pages.forEach((page) => {
        page.regions.forEach((region) => {
          if (
            region.selectionState !== "SELECTED" ||
            region.selectionSource !== "PII_AUTO" ||
            reviewedTextTargetsRef.current.has(region.id)
          ) {
            return;
          }

          const candidate = region.tokenIds
            .map((tokenId) => candidatesByToken.get(tokenId))
            .find(
              (item): item is MedicalRedactPiiCandidate => item !== undefined,
            );
          if (!candidate) return;
          const box = boxForAutoCandidate(region, candidate);
          if (!box) return;

          const key = targetKey("TEXT_REGION", region.id);
          const state: MedicalRedactReviewState = {
            entityType: candidate.entityType,
            entityRole: candidate.entityRole,
            box,
            selectionState: "SELECTED",
            selectionSource: "PII_AUTO",
          };
          targetsRef.current.set(key, {
            documentId: document.id,
            targetType: "TEXT_REGION",
            state,
          });
          reviewedTextTargetsRef.current.add(region.id);
          entityTypes[key] = candidate.entityType;
          enqueueAction(key, {
            documentId: document.id,
            targetType: "TEXT_REGION",
            targetId: region.id,
            action: "SELECT_TEXT",
            before: null,
            after: state,
          });
          changed = true;
        });
      });

      if (!changed) return;
      setTargetEntityTypes((current) => ({ ...current, ...entityTypes }));
      setSelectionRevision((current) => current + 1);
    },
    [enqueueAction],
  );

  const loadTextRegionsForFile = useCallback(
    async (
      fileId: string,
    ): Promise<MedicalRedactDocumentTextRegions | null> => {
      const document = documentForFile(fileId);
      const batch = batchRef.current;
      if (!document || !batch) return null;

      const cached = textRegionsByDocumentRef.current.get(document.id);
      if (cached) return cached;

      const existing = loadingTextRegionsRef.current.get(document.id);
      if (existing) return existing;

      const request = loadMedicalRedactTextRegions(batch.id, document.id)
        .then((regions) => {
          if (batchRef.current?.id !== batch.id) {
            throw new Error("脱敏任务已切换，请重新执行自动脱敏。");
          }
          textRegionsByDocumentRef.current.set(document.id, regions);
          setTextRegionRevision((current) => current + 1);
          return regions;
        })
        .finally(() => {
          loadingTextRegionsRef.current.delete(document.id);
        });

      loadingTextRegionsRef.current.set(document.id, request);
      return request;
    },
    [documentForFile],
  );

  const ensureTextRegions = useCallback(
    (fileId: string) => {
      void loadTextRegionsForFile(fileId).catch(() => {
        // Preserve the manual flow when text extraction/OCR is unavailable.
      });
    },
    [loadTextRegionsForFile],
  );

  const autoRedactDocument = useCallback(
    async (fileId: string) => {
      const document = documentForFile(fileId);
      if (!document) {
        setError("当前文件未关联到本地脱敏任务");
        return;
      }

      setAutoRedactingFileKey(fileId);
      try {
        const regions = await loadTextRegionsForFile(fileId);
        if (!regions) {
          setError("当前文件尚未完成敏感信息识别，无法执行自动脱敏。");
          return;
        }
        seedAutoSelections(document, regions);
        await Promise.all(Array.from(queuesRef.current.values()));
        setError(null);
      } catch (reason) {
        setError(
          medicalRedactUserErrorMessage(
            reason,
            "自动脱敏失败，请检查本地识别服务后重试。",
          ),
        );
      } finally {
        setAutoRedactingFileKey(null);
      }
    },
    [documentForFile, loadTextRegionsForFile, seedAutoSelections],
  );

  const getTextRegions = useCallback(
    (
      fileId: string,
      pageIndex: number,
    ): MedicalRedactSelectableTextRegion[] => {
      const document = documentForFile(fileId);
      const page = document?.pages[pageIndex];
      if (!document || !page) return [];
      const extracted = textRegionsByDocumentRef.current.get(document.id);
      return (
        extracted?.pages.find((item) => item.pageId === page.id)?.regions ?? []
      );
    },
    [documentForFile],
  );

  const isTextRegionSelected = useCallback((targetId: string) => {
    return isSelected(
      targetsRef.current.get(targetKey("TEXT_REGION", targetId))?.state,
    );
  }, []);

  const applyTextSelectionState = useCallback(
    (
      fileId: string,
      targetId: string,
      before: MedicalRedactReviewState | null,
      after: MedicalRedactReviewState,
    ) => {
      const document = documentForFile(fileId);
      if (!document) return;

      const key = targetKey("TEXT_REGION", targetId);
      if (isSelected(after)) {
        targetsRef.current.set(key, {
          documentId: document.id,
          targetType: "TEXT_REGION",
          state: after,
        });
        setTargetEntityTypes((current) => ({
          ...current,
          [key]: after.entityType ?? DEFAULT_ENTITY_TYPE,
        }));
      } else {
        targetsRef.current.delete(key);
        setTargetEntityTypes((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }

      setSelectionRevision((current) => current + 1);
      enqueueAction(key, {
        documentId: document.id,
        targetType: "TEXT_REGION",
        targetId,
        action: isSelected(after) ? "SELECT_TEXT" : "DESELECT_TEXT",
        before,
        after,
      });
    },
    [documentForFile, enqueueAction],
  );

  const setTextRegionSelected = useCallback(
    (
      fileId: string,
      targetId: string,
      box: MedicalRedactBox,
      selected: boolean,
      entityType?: string | null,
    ) => {
      const existing = targetsRef.current.get(
        targetKey("TEXT_REGION", targetId),
      );
      const resolvedEntityType =
        entityType ?? existing?.state.entityType ?? DEFAULT_ENTITY_TYPE;
      const before = existing?.state ?? null;
      const after: MedicalRedactReviewState = {
        entityType: resolvedEntityType,
        entityRole: resolvedEntityType === "PATIENT_NAME" ? "PATIENT" : null,
        box,
        selectionState: selected ? "SELECTED" : "UNSELECTED",
        selectionSource: "USER",
      };

      textUndoStackRef.current.push({ fileId, targetId, before, after });
      textRedoStackRef.current = [];
      setTextHistoryRevision((current) => current + 1);
      applyTextSelectionState(fileId, targetId, before, after);
    },
    [applyTextSelectionState],
  );

  const undoTextSelection = useCallback(() => {
    const entry = textUndoStackRef.current.pop();
    if (!entry) return;
    textRedoStackRef.current.push(entry);
    const current =
      targetsRef.current.get(targetKey("TEXT_REGION", entry.targetId))?.state ??
      null;
    const after = entry.before ?? {
      ...entry.after,
      selectionState: "UNSELECTED" as const,
      selectionSource: "USER" as const,
    };
    setTextHistoryRevision((revision) => revision + 1);
    applyTextSelectionState(entry.fileId, entry.targetId, current, after);
  }, [applyTextSelectionState]);

  const redoTextSelection = useCallback(() => {
    const entry = textRedoStackRef.current.pop();
    if (!entry) return;
    textUndoStackRef.current.push(entry);
    const current =
      targetsRef.current.get(targetKey("TEXT_REGION", entry.targetId))?.state ??
      null;
    setTextHistoryRevision((revision) => revision + 1);
    applyTextSelectionState(entry.fileId, entry.targetId, current, entry.after);
  }, [applyTextSelectionState]);

  const canUndoTextSelection = textUndoStackRef.current.length > 0;
  const canRedoTextSelection = textRedoStackRef.current.length > 0;
  void textHistoryRevision;

  const getTargetEntityType = useCallback(
    (targetType: MedicalRedactReviewTargetType, targetId: string) =>
      targetEntityTypes[targetKey(targetType, targetId)] ?? DEFAULT_ENTITY_TYPE,
    [targetEntityTypes],
  );

  const changeEntityType = useCallback(
    (
      fileId: string,
      targetType: MedicalRedactReviewTargetType,
      targetId: string,
      value: string,
    ) => {
      const document = documentForFile(fileId);
      const key = targetKey(targetType, targetId);
      const target = targetsRef.current.get(key);
      if (!document || !target || target.state.entityType === value) return;

      const before = target.state;
      const after: MedicalRedactReviewState = {
        ...before,
        entityType: value,
        entityRole: value === "PATIENT_NAME" ? "PATIENT" : null,
      };
      targetsRef.current.set(key, {
        ...target,
        state: after,
      });
      setTargetEntityTypes((current) => ({
        ...current,
        [key]: value,
      }));
      setSelectionRevision((current) => current + 1);
      enqueueAction(key, {
        documentId: document.id,
        targetType,
        targetId,
        action: "CHANGE_TYPE",
        before,
        after,
      });
    },
    [documentForFile, enqueueAction],
  );

  const getPiiCandidates = useCallback(
    (fileId: string): MedicalRedactPiiCandidate[] => {
      const document = documentForFile(fileId);
      if (!document) return [];
      return (
        textRegionsByDocumentRef.current.get(document.id)?.piiCandidates ?? []
      );
    },
    [documentForFile],
  );

  const getCandidateReviewState = useCallback(
    (fileId: string, candidateId: string): MedicalRedactReviewState | null => {
      const document = documentForFile(fileId);
      if (!document) return null;
      const candidate = (
        textRegionsByDocumentRef.current.get(document.id)?.piiCandidates ?? []
      ).find((item) => item.id === candidateId);
      if (!candidate) return null;

      const actions = batchRef.current?.reviewActions ?? [];
      for (let index = actions.length - 1; index >= 0; index--) {
        const action = actions[index];
        if (
          action.documentId === document.id &&
          action.targetType === "PII_CANDIDATE" &&
          action.targetId === candidateId &&
          action.after
        ) {
          return action.after;
        }
      }
      return {
        entityType: candidate.entityType,
        entityRole: candidate.entityRole,
        box: null,
        selectionState: "UNSELECTED",
        selectionSource: "NONE",
      };
    },
    [documentForFile],
  );

  const getCandidateDecision = useCallback(
    (
      fileId: string,
      candidateId: string,
    ): MedicalRedactCandidateDecision | null => {
      const document = documentForFile(fileId);
      if (!document) return null;
      const actions = batchRef.current?.reviewActions ?? [];
      for (let index = actions.length - 1; index >= 0; index--) {
        const action = actions[index];
        if (
          action.documentId !== document.id ||
          action.targetType !== "PII_CANDIDATE" ||
          action.targetId !== candidateId
        ) {
          continue;
        }
        if (action.action === "APPROVE" || action.action === "REJECT") {
          return action.action;
        }
      }
      return null;
    },
    [documentForFile],
  );

  const reviewCandidate = useCallback(
    (
      fileId: string,
      candidateId: string,
      decision: MedicalRedactCandidateDecision,
    ) => {
      const document = documentForFile(fileId);
      if (!document) return;
      const candidate = (
        textRegionsByDocumentRef.current.get(document.id)?.piiCandidates ?? []
      ).find((item) => item.id === candidateId);
      if (!candidate) return;
      const before = getCandidateReviewState(fileId, candidateId);
      const after =
        before ??
        ({
          entityType: candidate.entityType,
          entityRole: candidate.entityRole,
          box: null,
          selectionState: "UNSELECTED",
          selectionSource: "NONE",
        } satisfies MedicalRedactReviewState);
      enqueueAction(targetKey("PII_CANDIDATE", candidateId), {
        documentId: document.id,
        targetType: "PII_CANDIDATE",
        targetId: candidateId,
        action: decision,
        before,
        after,
      });
    },
    [documentForFile, enqueueAction, getCandidateReviewState],
  );

  const changeCandidateType = useCallback(
    (fileId: string, candidateId: string, entityType: string) => {
      const document = documentForFile(fileId);
      const before = getCandidateReviewState(fileId, candidateId);
      if (!document || !before || before.entityType === entityType) return;
      const after: MedicalRedactReviewState = {
        ...before,
        entityType,
        entityRole:
          entityType === "PATIENT_NAME" ? "PATIENT" : before.entityRole,
      };
      enqueueAction(targetKey("PII_CANDIDATE", candidateId), {
        documentId: document.id,
        targetType: "PII_CANDIDATE",
        targetId: candidateId,
        action: "CHANGE_TYPE",
        before,
        after,
      });
    },
    [documentForFile, enqueueAction, getCandidateReviewState],
  );

  const changeCandidateRole = useCallback(
    (fileId: string, candidateId: string, entityRole: string | null) => {
      const document = documentForFile(fileId);
      const before = getCandidateReviewState(fileId, candidateId);
      if (!document || !before || before.entityRole === entityRole) return;
      const after: MedicalRedactReviewState = {
        ...before,
        entityRole,
      };
      enqueueAction(targetKey("PII_CANDIDATE", candidateId), {
        documentId: document.id,
        targetType: "PII_CANDIDATE",
        targetId: candidateId,
        action: "CHANGE_ROLE",
        before,
        after,
      });
    },
    [documentForFile, enqueueAction, getCandidateReviewState],
  );

  const getSelectedCount = useCallback(
    (fileId: string) => {
      const document = documentForFile(fileId);
      if (!document) return 0;
      return Array.from(targetsRef.current.values()).filter(
        (target) =>
          target.documentId === document.id && isSelected(target.state),
      ).length;
    },
    [documentForFile],
  );

  const getSelectionSummary = useCallback(
    (fileId: string): MedicalRedactSelectionSummary => {
      const document = documentForFile(fileId);
      const summary: MedicalRedactSelectionSummary = {
        total: 0,
        auto: 0,
        user: 0,
        manual: 0,
      };
      if (!document) return summary;

      Array.from(targetsRef.current.values()).forEach((target) => {
        if (target.documentId !== document.id || !isSelected(target.state)) {
          return;
        }
        summary.total += 1;
        if (target.state.selectionSource === "PII_AUTO") {
          summary.auto += 1;
        } else if (target.state.selectionSource === "MANUAL_RECTANGLE") {
          summary.manual += 1;
        } else {
          summary.user += 1;
        }
      });
      return summary;
    },
    [documentForFile],
  );

  const getSelectedBoxes = useCallback(
    (fileId: string, pageIndex: number): SelectedBox[] => {
      const document = documentForFile(fileId);
      const page = document?.pages[pageIndex];
      if (!document || !page) return [];

      return Array.from(targetsRef.current.entries()).flatMap(
        ([key, target]) => {
          const box = target.state.box;
          if (
            target.documentId !== document.id ||
            !isSelected(target.state) ||
            !box ||
            box.pageId !== page.id
          ) {
            return [];
          }
          return [{ id: key, box }];
        },
      );
    },
    [documentForFile],
  );

  const getVerificationReport = useCallback(
    (fileId: string): MedicalRedactVerificationReport | null => {
      const document = documentForFile(fileId);
      if (!document || !batchSnapshot) return null;
      for (
        let index = batchSnapshot.verificationReports.length - 1;
        index >= 0;
        index--
      ) {
        const report = batchSnapshot.verificationReports[index];
        if (report.documentId === document.id) return report;
      }
      return null;
    },
    [batchSnapshot, documentForFile],
  );

  const finalizeDocument = useCallback(
    async (fileId: string) => {
      const document = documentForFile(fileId);
      const batch = batchRef.current;
      if (!document || !batch) {
        setError("当前文件未关联到本地脱敏任务");
        return;
      }
      setFinalizingFileKey(fileId);
      try {
        await Promise.all(Array.from(queuesRef.current.values()));
        const latestBatch = batchRef.current;
        if (!latestBatch) return;
        const verificationEnabled =
          isMedicalRedactSecurityVerificationEnabled();
        const updated = await finalizeMedicalRedactDocument(
          latestBatch.id,
          document.id,
          verificationEnabled,
        );
        batchRef.current = updated;
        setBatchSnapshot(updated);
        const report = [...updated.verificationReports]
          .reverse()
          .find((item) => item.documentId === document.id);
        if (report?.status === "PASS" || report?.status === "SKIPPED") {
          setError(null);
          setFinalPreview(true);
        } else {
          setError(
            report
              ? medicalRedactVerificationMessages(report)[0]
              : "安全验证未通过，请检查脱敏内容后重新生成。",
          );
        }
      } catch (reason) {
        setError(
          medicalRedactUserErrorMessage(
            reason,
            "生成脱敏文件失败，请稍后重试。",
          ),
        );
      } finally {
        setFinalizingFileKey(null);
      }
    },
    [documentForFile],
  );

  const exportVerifiedDocument = useCallback(
    async (fileId: string) => {
      const document = documentForFile(fileId);
      const batch = batchRef.current;
      const report = getVerificationReport(fileId);
      if (
        !document ||
        !batch ||
        (report?.status !== "PASS" && report?.status !== "SKIPPED") ||
        !report.outputFilename
      ) {
        setError("请先生成脱敏文件后再导出。");
        return;
      }
      setExportingFileKey(fileId);
      try {
        const blob = await downloadMedicalRedactOutput(batch.id, document.id);
        await downloadFile({ data: blob, filename: report.outputFilename });
        setError(null);
      } catch (reason) {
        setError(
          medicalRedactUserErrorMessage(
            reason,
            "导出脱敏文件失败，请稍后重试。",
          ),
        );
      } finally {
        setExportingFileKey(null);
      }
    },
    [documentForFile, getVerificationReport],
  );

  const value = useMemo(
    () => ({
      entityTypes: MEDICAL_REDACT_ENTITY_TYPE_OPTIONS,
      batch: batchSnapshot,
      error,
      isFinalPreview,
      manualRedactMode,
      verificationFocusBox,
      sessionRevision,
      selectionRevision,
      textRegionRevision,
      autoRedactingFileKey,
      finalizingFileKey,
      exportingFileKey,
      canUndoTextSelection,
      canRedoTextSelection,
      canUndoManualReview,
      canRedoManualReview,
      setFinalPreview,
      setManualRedactMode,
      setVerificationFocusBox,
      startSession,
      getRestoredRedactions,
      recordRedactionEvent,
      recordGeometryChange,
      ensureTextRegions,
      autoRedactDocument,
      getTextRegions,
      isTextRegionSelected,
      setTextRegionSelected,
      undoTextSelection,
      redoTextSelection,
      undoManualReview,
      redoManualReview,
      getTargetEntityType,
      changeEntityType,
      getDocument: documentForFile,
      getPiiCandidates,
      getCandidateReviewState,
      getCandidateDecision,
      reviewCandidate,
      changeCandidateType,
      changeCandidateRole,
      getSelectedCount,
      getSelectionSummary,
      getSelectedBoxes,
      getVerificationReport,
      finalizeDocument,
      exportVerifiedDocument,
    }),
    [
      canRedoManualReview,
      canRedoTextSelection,
      canUndoManualReview,
      batchSnapshot,
      canUndoTextSelection,
      changeCandidateRole,
      changeCandidateType,
      changeEntityType,
      documentForFile,
      error,
      autoRedactDocument,
      autoRedactingFileKey,
      exportingFileKey,
      exportVerifiedDocument,
      finalizingFileKey,
      ensureTextRegions,
      finalizeDocument,
      getCandidateDecision,
      getCandidateReviewState,
      getPiiCandidates,
      getRestoredRedactions,
      getSelectedBoxes,
      getTextRegions,
      getSelectedCount,
      getSelectionSummary,
      getTargetEntityType,
      getVerificationReport,
      isFinalPreview,
      isTextRegionSelected,
      manualRedactMode,
      verificationFocusBox,
      recordGeometryChange,
      recordRedactionEvent,
      reviewCandidate,
      redoManualReview,
      redoTextSelection,
      selectionRevision,
      setTextRegionSelected,
      textRegionRevision,
      sessionRevision,
      startSession,
      undoManualReview,
      undoTextSelection,
    ],
  );

  return (
    <MedicalRedactReviewContext.Provider value={value}>
      {children}
    </MedicalRedactReviewContext.Provider>
  );
}

export function useMedicalRedactReview() {
  const context = useContext(MedicalRedactReviewContext);
  if (!context) {
    throw new Error(
      "useMedicalRedactReview must be used within MedicalRedactReviewProvider",
    );
  }
  return context;
}
