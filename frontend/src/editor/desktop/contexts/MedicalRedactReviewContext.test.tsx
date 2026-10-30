import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RedactionItem } from "@embedpdf/plugin-redaction";

const saveReviewAction = vi.hoisted(() => vi.fn());
const loadTextRegions = vi.hoisted(() => vi.fn());

vi.mock("@app/services/medicalRedactTaskService", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@app/services/medicalRedactTaskService")
    >();
  return {
    ...original,
    loadMedicalRedactTextRegions: loadTextRegions,
    saveMedicalRedactReviewAction: saveReviewAction,
  };
});

import {
  MedicalRedactReviewProvider,
  useMedicalRedactReview,
} from "@app/contexts/MedicalRedactReviewContext";
import type { MedicalRedactBatch } from "@app/services/medicalRedactTaskService";

const batch: MedicalRedactBatch = {
  id: "batch-1",
  name: "审核测试",
  sourceType: "FILES",
  createdAt: "2026-10-26T00:00:00Z",
  status: "IMPORTED",
  documentCount: 1,
  processedCount: 0,
  reviewRequiredCount: 0,
  blockedCount: 0,
  sourceHash: "a".repeat(64),
  reviewActions: [],
  verificationReports: [],
  documents: [
    {
      id: "document-1",
      batchId: "batch-1",
      originalFilename: "record.pdf",
      sourceRelativePath: "source/batch-1/document-1.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: "b".repeat(64),
      fileSize: 100,
      pageCount: 1,
      documentType: "unknown",
      status: "IMPORTED",
      processingVersion: "p0",
      pages: [
        {
          id: "document-1-P0001",
          documentId: "document-1",
          pageNo: 1,
          width: 595,
          height: 842,
          sourceKind: "PDF",
          rotation: 0,
          renderDpi: null,
          status: "IMPORTED",
        },
      ],
    },
  ],
};

function wrapper({ children }: { children: ReactNode }) {
  return <MedicalRedactReviewProvider>{children}</MedicalRedactReviewProvider>;
}

function reviewFile() {
  const file = new File(["pdf"], "record.pdf", {
    type: "application/pdf",
  });
  Object.defineProperty(file, "fileId", { value: "file-1" });
  return file;
}

function redactionItem(rect = { x: 10, y: 20, width: 80, height: 18 }) {
  return {
    id: "candidate-1",
    page: 0,
    kind: "text",
    source: "legacy",
    text: "张三",
    markColor: "#000000",
    redactionColor: "#000000",
    rect: {
      origin: { x: rect.x, y: rect.y },
      size: { width: rect.width, height: rect.height },
    },
    rects: [],
  } satisfies RedactionItem;
}

describe("MedicalRedactReviewProvider", () => {
  beforeEach(() => {
    saveReviewAction.mockReset();
    saveReviewAction.mockResolvedValue(batch);
    loadTextRegions.mockReset();
    loadTextRegions.mockResolvedValue({
      documentId: "document-1",
      engineAvailable: false,
      piiAvailable: false,
      piiCandidates: [],
      pages: [
        {
          pageId: "document-1-P0001",
          pageNo: 1,
          mode: "PDF_TEXT",
          tokens: [],
          warningCode: null,
          elapsedMs: 2,
          regions: [
            {
              id: "region-1",
              documentId: "document-1",
              pageId: "document-1-P0001",
              tokenIds: ["token-1"],
              polygon: [
                { x: 44, y: 55 },
                { x: 110, y: 55 },
                { x: 110, y: 73 },
                { x: 44, y: 73 },
              ],
              source: "PDF_TEXT",
              confidence: 1,
              selectionState: "UNSELECTED",
              selectionSource: "NONE",
            },
          ],
        },
      ],
    });
  });

  test("persists add, type, geometry and delete events without sensitive text", async () => {
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });
    const item = redactionItem();

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.recordRedactionEvent("file-1", {
        type: "add",
        documentId: "viewer-document-1",
        items: [item],
      });
    });
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(1));
    expect(saveReviewAction.mock.calls[0][1]).toMatchObject({
      action: "ADD_MANUAL",
      documentId: "document-1",
      targetType: "MANUAL_RECTANGLE",
      targetId: "candidate-1",
      after: {
        entityType: "OTHER",
        selectionState: "SELECTED",
        selectionSource: "MANUAL_RECTANGLE",
        box: { pageId: "document-1-P0001", x: 10, y: 20 },
      },
    });
    expect(JSON.stringify(saveReviewAction.mock.calls[0][1])).not.toContain(
      "张三",
    );

    act(() => {
      result.current.changeEntityType(
        "file-1",
        "MANUAL_RECTANGLE",
        "candidate-1",
        "PATIENT_NAME",
      );
      result.current.recordGeometryChange(
        "file-1",
        redactionItem({ x: 30, y: 40, width: 80, height: 18 }),
      );
      result.current.recordGeometryChange(
        "file-1",
        redactionItem({ x: 30, y: 40, width: 100, height: 18 }),
      );
      result.current.recordRedactionEvent("file-1", {
        type: "remove",
        documentId: "viewer-document-1",
        page: 0,
        id: "candidate-1",
      });
    });

    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(5));
    expect(
      saveReviewAction.mock.calls.slice(1).map((call) => call[1].action),
    ).toEqual(["CHANGE_TYPE", "MOVE", "RESIZE", "DELETE_MANUAL"]);
  });

  test("loads selectable text regions lazily for the active review file", async () => {
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.ensureTextRegions("file-1");
    });

    await waitFor(() =>
      expect(result.current.getTextRegions("file-1", 0)).toHaveLength(1),
    );
    expect(loadTextRegions).toHaveBeenCalledWith("batch-1", "document-1");
    expect(result.current.getTextRegions("file-1", 0)[0]).toMatchObject({
      id: "region-1",
      source: "PDF_TEXT",
    });
  });

  test("persists text region select and deselect into the unified selection set", async () => {
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.setTextRegionSelected(
        "file-1",
        "text-region-1",
        {
          pageId: "document-1-P0001",
          x: 44,
          y: 55,
          width: 66,
          height: 18,
        },
        true,
        "PATIENT_NAME",
      );
    });

    expect(result.current.getSelectedCount("file-1")).toBe(1);
    expect(result.current.getSelectedBoxes("file-1", 0)).toEqual([
      expect.objectContaining({
        id: "TEXT_REGION:text-region-1",
        box: expect.objectContaining({ x: 44, y: 55 }),
      }),
    ]);
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(1));
    expect(saveReviewAction.mock.calls[0][1]).toMatchObject({
      documentId: "document-1",
      targetType: "TEXT_REGION",
      targetId: "text-region-1",
      action: "SELECT_TEXT",
      after: {
        entityType: "PATIENT_NAME",
        entityRole: "PATIENT",
        selectionState: "SELECTED",
        selectionSource: "USER",
      },
    });

    act(() => {
      result.current.setTextRegionSelected(
        "file-1",
        "text-region-1",
        {
          pageId: "document-1-P0001",
          x: 44,
          y: 55,
          width: 66,
          height: 18,
        },
        false,
      );
    });

    expect(result.current.getSelectedCount("file-1")).toBe(0);
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(2));
    expect(saveReviewAction.mock.calls[1][1]).toMatchObject({
      targetType: "TEXT_REGION",
      targetId: "text-region-1",
      action: "DESELECT_TEXT",
      before: expect.objectContaining({ selectionState: "SELECTED" }),
      after: expect.objectContaining({ selectionState: "UNSELECTED" }),
    });
  });

  test("undoes and redoes text selection by persisting inverse review actions", async () => {
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });
    const box = {
      pageId: "document-1-P0001",
      x: 44,
      y: 55,
      width: 66,
      height: 18,
    };

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.setTextRegionSelected(
        "file-1",
        "text-region-1",
        box,
        true,
        "PATIENT_NAME",
      );
    });
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(1));
    expect(result.current.canUndoTextSelection).toBe(true);
    expect(result.current.canRedoTextSelection).toBe(false);

    act(() => result.current.undoTextSelection());
    expect(result.current.isTextRegionSelected("text-region-1")).toBe(false);
    expect(result.current.getSelectedCount("file-1")).toBe(0);
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(2));
    expect(saveReviewAction.mock.calls[1][1]).toMatchObject({
      targetType: "TEXT_REGION",
      targetId: "text-region-1",
      action: "DESELECT_TEXT",
      before: expect.objectContaining({ selectionState: "SELECTED" }),
      after: expect.objectContaining({ selectionState: "UNSELECTED" }),
    });
    expect(result.current.canUndoTextSelection).toBe(false);
    expect(result.current.canRedoTextSelection).toBe(true);

    act(() => result.current.redoTextSelection());
    expect(result.current.isTextRegionSelected("text-region-1")).toBe(true);
    expect(result.current.getSelectedCount("file-1")).toBe(1);
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(3));
    expect(saveReviewAction.mock.calls[2][1]).toMatchObject({
      targetType: "TEXT_REGION",
      targetId: "text-region-1",
      action: "SELECT_TEXT",
      after: expect.objectContaining({
        entityType: "PATIENT_NAME",
        selectionState: "SELECTED",
      }),
    });
    expect(JSON.stringify(saveReviewAction.mock.calls)).not.toContain("张三");
  });

  test("materializes only the latest non-deleted review states for restart", () => {
    const initial = {
      entityType: "OTHER",
      entityRole: null,
      box: {
        pageId: "document-1-P0001",
        x: 10,
        y: 20,
        width: 80,
        height: 18,
      },
      selectionState: "SELECTED" as const,
      selectionSource: "MANUAL_RECTANGLE" as const,
    };
    const moved = {
      ...initial,
      entityType: "PATIENT_NAME",
      entityRole: "PATIENT",
      box: { ...initial.box, x: 30, width: 100 },
    };
    const restoredBatch: MedicalRedactBatch = {
      ...batch,
      reviewActions: [
        {
          id: "action-1",
          documentId: "document-1",
          targetType: "MANUAL_RECTANGLE",
          targetId: "candidate-1",
          action: "ADD_MANUAL",
          before: null,
          after: initial,
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:01Z",
        },
        {
          id: "action-2",
          documentId: "document-1",
          targetType: "MANUAL_RECTANGLE",
          targetId: "candidate-1",
          action: "RESIZE",
          before: initial,
          after: moved,
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:02Z",
        },
        {
          id: "action-3",
          documentId: "document-1",
          targetType: "MANUAL_RECTANGLE",
          targetId: "candidate-deleted",
          action: "DELETE_MANUAL",
          before: initial,
          after: null,
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:03Z",
        },
        {
          id: "action-4",
          documentId: "document-1",
          targetType: "TEXT_REGION",
          targetId: "region-restored",
          action: "SELECT_TEXT",
          before: null,
          after: {
            entityType: "CN_ID_CARD",
            entityRole: null,
            box: {
              pageId: "document-1-P0001",
              x: 150,
              y: 90,
              width: 120,
              height: 18,
            },
            selectionState: "SELECTED",
            selectionSource: "USER",
          },
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:04Z",
        },
      ],
    };
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => result.current.setFinalPreview(true));
    expect(result.current.isFinalPreview).toBe(true);

    act(() => result.current.startSession(restoredBatch, [reviewFile()]));

    expect(result.current.isFinalPreview).toBe(false);
    expect(
      result.current.getTargetEntityType("MANUAL_RECTANGLE", "candidate-1"),
    ).toBe("PATIENT_NAME");
    expect(result.current.getSelectedCount("file-1")).toBe(2);
    expect(result.current.isTextRegionSelected("region-restored")).toBe(true);
    expect(
      result.current.getTargetEntityType("TEXT_REGION", "region-restored"),
    ).toBe("CN_ID_CARD");
    expect(result.current.getRestoredRedactions("file-1")).toEqual([
      expect.objectContaining({
        id: "candidate-1",
        page: 0,
        kind: "area",
        rect: {
          origin: { x: 30, y: 20 },
          size: { width: 100, height: 18 },
        },
      }),
    ]);
    expect(saveReviewAction).not.toHaveBeenCalled();
  });

  test("applies PII auto selections only after explicit auto redact", async () => {
    loadTextRegions.mockResolvedValueOnce({
      documentId: "document-1",
      engineAvailable: false,
      piiAvailable: true,
      piiCandidates: [
        {
          id: "pii-1",
          entityType: "PHONE",
          entityRole: null,
          normalizedStart: 0,
          normalizedEnd: 11,
          sourceStart: 0,
          sourceEnd: 11,
          confidence: 0.96,
          overallConfidence: 0.96,
          detector: "presidio-cn-mobile-phone",
          detectorEvidence: ["presidio-cn-mobile-phone"],
          pageIds: ["document-1-P0001"],
          tokenIds: ["token-1"],
          alignment: {
            level: "A",
            confidence: 1,
            method: "PDF_NATIVE_CHAR",
            polygons: [
              {
                pageId: "document-1-P0001",
                points: [
                  { x: 50, y: 57 },
                  { x: 100, y: 57 },
                  { x: 100, y: 71 },
                  { x: 50, y: 71 },
                ],
              },
            ],
            warnings: [],
            needsLocalReocr: false,
            unresolved: false,
          },
          policy: "AUTO_SELECT",
          riskStatus: "RESOLVED",
          conflict: false,
        },
      ],
      pages: [
        {
          pageId: "document-1-P0001",
          pageNo: 1,
          mode: "PDF_TEXT",
          tokens: [],
          warningCode: null,
          elapsedMs: 2,
          regions: [
            {
              id: "region-1",
              documentId: "document-1",
              pageId: "document-1-P0001",
              tokenIds: ["token-1"],
              polygon: [
                { x: 44, y: 55 },
                { x: 110, y: 55 },
                { x: 110, y: 73 },
                { x: 44, y: 73 },
              ],
              source: "PDF_TEXT",
              confidence: 1,
              selectionState: "SELECTED",
              selectionSource: "PII_AUTO",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.ensureTextRegions("file-1");
    });

    await waitFor(() => expect(loadTextRegions).toHaveBeenCalledTimes(1));
    expect(result.current.getSelectedCount("file-1")).toBe(0);
    expect(saveReviewAction).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.autoRedactDocument("file-1");
    });

    await waitFor(() =>
      expect(result.current.getSelectedCount("file-1")).toBe(1),
    );
    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(1));
    expect(saveReviewAction.mock.calls[0][1]).toMatchObject({
      targetType: "TEXT_REGION",
      targetId: "region-1",
      action: "SELECT_TEXT",
      after: {
        entityType: "PHONE",
        selectionState: "SELECTED",
        selectionSource: "PII_AUTO",
        box: {
          pageId: "document-1-P0001",
          x: 50,
          y: 57,
          width: 50,
          height: 14,
        },
      },
    });
    expect(JSON.stringify(saveReviewAction.mock.calls[0][1])).not.toContain(
      "13800000001",
    );

    act(() => {
      result.current.setTextRegionSelected(
        "file-1",
        "region-1",
        {
          pageId: "document-1-P0001",
          x: 44,
          y: 55,
          width: 66,
          height: 18,
        },
        false,
      );
    });

    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(2));
    expect(result.current.isTextRegionSelected("region-1")).toBe(false);
    expect(saveReviewAction.mock.calls[1][1]).toMatchObject({
      targetType: "TEXT_REGION",
      targetId: "region-1",
      action: "DESELECT_TEXT",
      after: {
        selectionState: "UNSELECTED",
        selectionSource: "USER",
      },
    });
  });

  test("does not auto-select REVIEW policy candidates", async () => {
    loadTextRegions.mockResolvedValueOnce({
      documentId: "document-1",
      engineAvailable: false,
      piiAvailable: true,
      piiCandidates: [
        {
          id: "pii-review",
          entityType: "DOCTOR_NAME",
          entityRole: "DOCTOR",
          normalizedStart: 0,
          normalizedEnd: 4,
          sourceStart: 0,
          sourceEnd: 4,
          confidence: 0.9,
          overallConfidence: 0.9,
          detector: "ner-context-doctor-name",
          detectorEvidence: ["ner-context-doctor-name"],
          pageIds: ["document-1-P0001"],
          tokenIds: ["token-1"],
          alignment: {
            level: "A",
            confidence: 1,
            method: "PDF_NATIVE_CHAR",
            polygons: [
              {
                pageId: "document-1-P0001",
                points: [
                  { x: 50, y: 57 },
                  { x: 100, y: 57 },
                  { x: 100, y: 71 },
                  { x: 50, y: 71 },
                ],
              },
            ],
            warnings: [],
            needsLocalReocr: false,
            unresolved: false,
          },
          policy: "REVIEW",
          riskStatus: "REVIEW",
          conflict: false,
        },
      ],
      pages: [
        {
          pageId: "document-1-P0001",
          pageNo: 1,
          mode: "PDF_TEXT",
          tokens: [],
          warningCode: null,
          elapsedMs: 2,
          regions: [
            {
              id: "region-1",
              documentId: "document-1",
              pageId: "document-1-P0001",
              tokenIds: ["token-1"],
              polygon: [
                { x: 44, y: 55 },
                { x: 110, y: 55 },
                { x: 110, y: 73 },
                { x: 44, y: 73 },
              ],
              source: "PDF_TEXT",
              confidence: 1,
              selectionState: "UNSELECTED",
              selectionSource: "NONE",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.ensureTextRegions("file-1");
    });

    await waitFor(() => expect(loadTextRegions).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.autoRedactDocument("file-1");
    });
    expect(result.current.isTextRegionSelected("region-1")).toBe(false);
    expect(saveReviewAction).not.toHaveBeenCalled();
  });

  test("keeps high-risk candidates in the existing review flow and persists explicit decisions", async () => {
    loadTextRegions.mockResolvedValueOnce({
      documentId: "document-1",
      engineAvailable: true,
      piiAvailable: true,
      piiCandidates: [
        {
          id: "pii-high-risk",
          entityType: "PHONE",
          entityRole: "PATIENT",
          normalizedStart: 0,
          normalizedEnd: 11,
          sourceStart: 0,
          sourceEnd: 11,
          confidence: 0.96,
          overallConfidence: 0.65,
          detector: "presidio-cn-mobile-phone",
          detectorEvidence: ["presidio-cn-mobile-phone"],
          pageIds: ["document-1-P0001"],
          tokenIds: ["token-1"],
          alignment: {
            level: "C",
            confidence: 0.65,
            method: "TOKEN_PARTIAL",
            polygons: [],
            warnings: ["LOCAL_REOCR_LIMIT_EXCEEDED"],
            needsLocalReocr: true,
            unresolved: false,
          },
          policy: "REVIEW",
          riskStatus: "HIGH_RISK",
          conflict: false,
        },
      ],
      pages: [
        {
          pageId: "document-1-P0001",
          pageNo: 1,
          mode: "PADDLE_OCR",
          tokens: [],
          warningCode: null,
          elapsedMs: 2,
          regions: [
            {
              id: "region-1",
              documentId: "document-1",
              pageId: "document-1-P0001",
              tokenIds: ["token-1"],
              polygon: [
                { x: 44, y: 55 },
                { x: 110, y: 55 },
                { x: 110, y: 73 },
                { x: 44, y: 73 },
              ],
              source: "PADDLE_OCR",
              confidence: 0.65,
              selectionState: "UNSELECTED",
              selectionSource: "NONE",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(batch, [reviewFile()]);
      result.current.ensureTextRegions("file-1");
    });

    await waitFor(() =>
      expect(result.current.getPiiCandidates("file-1")).toHaveLength(1),
    );
    expect(result.current.getPiiCandidates("file-1")[0].riskStatus).toBe(
      "HIGH_RISK",
    );
    expect(result.current.getSelectionSummary("file-1")).toEqual({
      total: 0,
      auto: 0,
      user: 0,
      manual: 0,
    });

    act(() => {
      result.current.reviewCandidate("file-1", "pii-high-risk", "APPROVE");
    });

    await waitFor(() => expect(saveReviewAction).toHaveBeenCalledTimes(1));
    expect(saveReviewAction.mock.calls[0][1]).toMatchObject({
      documentId: "document-1",
      targetType: "PII_CANDIDATE",
      targetId: "pii-high-risk",
      action: "APPROVE",
      after: {
        entityType: "PHONE",
        entityRole: "PATIENT",
        box: null,
        selectionState: "UNSELECTED",
        selectionSource: "NONE",
      },
    });
  });

  test("does not reapply an auto selection after the user previously deselected it", async () => {
    const autoState = {
      entityType: "PHONE",
      entityRole: null,
      box: {
        pageId: "document-1-P0001",
        x: 44,
        y: 55,
        width: 66,
        height: 18,
      },
      selectionState: "SELECTED" as const,
      selectionSource: "PII_AUTO" as const,
    };
    const restoredBatch: MedicalRedactBatch = {
      ...batch,
      reviewActions: [
        {
          id: "action-auto",
          documentId: "document-1",
          targetType: "TEXT_REGION",
          targetId: "region-1",
          action: "SELECT_TEXT",
          before: null,
          after: autoState,
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:01Z",
        },
        {
          id: "action-deselect",
          documentId: "document-1",
          targetType: "TEXT_REGION",
          targetId: "region-1",
          action: "DESELECT_TEXT",
          before: autoState,
          after: {
            ...autoState,
            selectionState: "UNSELECTED",
            selectionSource: "USER",
          },
          operatorId: "local-user",
          createdAt: "2026-10-26T00:00:02Z",
        },
      ],
    };
    loadTextRegions.mockResolvedValueOnce({
      documentId: "document-1",
      engineAvailable: false,
      piiAvailable: true,
      piiCandidates: [
        {
          id: "pii-1",
          entityType: "PHONE",
          entityRole: null,
          normalizedStart: 0,
          normalizedEnd: 11,
          sourceStart: 0,
          sourceEnd: 11,
          confidence: 0.96,
          overallConfidence: 0.96,
          detector: "presidio-cn-mobile-phone",
          detectorEvidence: ["presidio-cn-mobile-phone"],
          pageIds: ["document-1-P0001"],
          tokenIds: ["token-1"],
          alignment: {
            level: "A",
            confidence: 1,
            method: "PDF_NATIVE_CHAR",
            polygons: [
              {
                pageId: "document-1-P0001",
                points: [
                  { x: 50, y: 57 },
                  { x: 100, y: 57 },
                  { x: 100, y: 71 },
                  { x: 50, y: 71 },
                ],
              },
            ],
            warnings: [],
            needsLocalReocr: false,
            unresolved: false,
          },
          policy: "AUTO_SELECT",
          riskStatus: "RESOLVED",
          conflict: false,
        },
      ],
      pages: [
        {
          pageId: "document-1-P0001",
          pageNo: 1,
          mode: "PDF_TEXT",
          tokens: [],
          warningCode: null,
          elapsedMs: 2,
          regions: [
            {
              id: "region-1",
              documentId: "document-1",
              pageId: "document-1-P0001",
              tokenIds: ["token-1"],
              polygon: [
                { x: 44, y: 55 },
                { x: 110, y: 55 },
                { x: 110, y: 73 },
                { x: 44, y: 73 },
              ],
              source: "PDF_TEXT",
              confidence: 1,
              selectionState: "SELECTED",
              selectionSource: "PII_AUTO",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(() => useMedicalRedactReview(), { wrapper });

    act(() => {
      result.current.startSession(restoredBatch, [reviewFile()]);
      result.current.ensureTextRegions("file-1");
    });

    await waitFor(() => expect(loadTextRegions).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.autoRedactDocument("file-1");
    });
    expect(result.current.isTextRegionSelected("region-1")).toBe(false);
    expect(saveReviewAction).not.toHaveBeenCalled();
  });
});
