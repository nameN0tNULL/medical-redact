import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@app/services/apiClient", () => ({ default: api }));
vi.mock("@app/utils/uploadableFile", () => ({
  uploadableFile: (file: File) => file,
}));

import {
  createMedicalRedactBatch,
  downloadMedicalRedactDocument,
  downloadMedicalRedactOutput,
  finalizeMedicalRedactDocument,
  importMedicalRedactDocuments,
  listMedicalRedactBatches,
  loadMedicalRedactRuntimeCapabilities,
  loadMedicalRedactTextRegions,
  saveMedicalRedactReviewAction,
} from "@app/services/medicalRedactTaskService";

describe("medicalRedactTaskService", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
  });

  test("creates and lists persisted batches through the local backend", async () => {
    const batch = {
      id: "batch-1",
      name: "测试",
      documents: [],
    };
    api.post.mockResolvedValueOnce({ data: batch });
    api.get.mockResolvedValueOnce({ data: [batch] });

    await expect(createMedicalRedactBatch("测试")).resolves.toBe(batch);
    await expect(listMedicalRedactBatches()).resolves.toEqual([batch]);

    expect(api.post).toHaveBeenCalledWith("/api/v1/medical-redact/batches", {
      name: "测试",
      knownEntities: [],
    });
    expect(api.get).toHaveBeenCalledWith("/api/v1/medical-redact/batches", {
      suppressErrorToast: true,
    });
  });

  test("uploads all selected files into the batch workspace", async () => {
    api.post.mockResolvedValueOnce({ data: { id: "batch-1" } });
    const files = [
      new File(["one"], "one.pdf", { type: "application/pdf" }),
      new File(["two"], "two.pdf", { type: "application/pdf" }),
    ];

    await importMedicalRedactDocuments("batch-1", files);

    const [, form] = api.post.mock.calls[0];
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).getAll("files")).toHaveLength(2);
  });

  test("loads review derivatives and verified outputs through gated endpoints", async () => {
    const reviewBlob = new Blob(["review"], { type: "application/pdf" });
    const outputBlob = new Blob(["output"], { type: "application/pdf" });
    api.get.mockResolvedValueOnce({ data: reviewBlob });
    api.post.mockResolvedValueOnce({
      data: { id: "batch-1", status: "VERIFIED" },
    });
    api.get.mockResolvedValueOnce({ data: outputBlob });

    const document = {
      id: "document-1",
      batchId: "batch-1",
      originalFilename: "patient-name.png",
      sourceRelativePath: "source/batch-1/document-1.png",
      fileType: "png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      fileSize: 100,
      pageCount: 1,
      documentType: "unknown",
      status: "IMPORTED",
      processingVersion: "p0",
      pages: [],
    };

    const review = await downloadMedicalRedactDocument("batch-1", document);
    expect(review.name).toBe("document-1.pdf");
    expect(review.type).toBe("application/pdf");
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/medical-redact/batches/batch-1/documents/document-1/review",
      { responseType: "blob" },
    );

    await finalizeMedicalRedactDocument("batch-1", "document-1");
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/medical-redact/batches/batch-1/documents/document-1/finalize?verify=true",
      {},
    );

    await expect(
      downloadMedicalRedactOutput("batch-1", "document-1"),
    ).resolves.toBe(outputBlob);
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/medical-redact/batches/batch-1/documents/document-1/output",
      { responseType: "blob" },
    );
  });

  test("can generate output with security verification disabled", async () => {
    api.post.mockResolvedValueOnce({
      data: { id: "batch-1", status: "VERIFIED" },
    });

    await finalizeMedicalRedactDocument("batch-1", "document-1", false);

    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/medical-redact/batches/batch-1/documents/document-1/finalize?verify=false",
      {},
    );
  });

  test("loads local runtime capabilities", async () => {
    const capabilities = {
      os: "macOS",
      osVersion: "15.3",
      arch: "arm64",
      cpuModel: "Apple M1 Pro",
      physicalCores: 8,
      logicalCores: 8,
      totalMemoryBytes: 17179869184,
      appleSilicon: true,
      nvidiaGpu: false,
      nvidiaGpuName: null,
      nvidiaVramBytes: null,
      availableRuntimes: ["CPU"],
      detectedAccelerators: ["APPLE_SILICON"],
      workerSchedule: {
        memoryTier: "STANDARD",
        ocrWorkers: 1,
        nerWorkers: 1,
        preprocessWorkers: 2,
        renderCachePages: 4,
        ocrModelTier: "SMALL",
        optionalModelsEnabled: false,
      },
    };
    api.get.mockResolvedValueOnce({ data: capabilities });

    await expect(loadMedicalRedactRuntimeCapabilities()).resolves.toBe(
      capabilities,
    );
    expect(api.get).toHaveBeenCalledWith(
      "/api/v1/medical-redact/runtime/capabilities",
    );
  });

  test("loads unified text regions for a review document", async () => {
    const regions = {
      documentId: "document-1",
      engineAvailable: false,
      piiAvailable: true,
      piiCandidates: [],
      pages: [],
    };
    api.get.mockResolvedValueOnce({ data: regions });

    await expect(
      loadMedicalRedactTextRegions("batch-1", "document-1"),
    ).resolves.toBe(regions);
    expect(api.get).toHaveBeenCalledWith(
      "/api/v1/medical-redact/batches/batch-1/documents/document-1/text-regions",
    );
  });

  test("appends a typed review action to the local batch", async () => {
    const updated = { id: "batch-1", status: "IN_REVIEW" };
    api.post.mockResolvedValueOnce({ data: updated });
    const action = {
      documentId: "document-1",
      targetType: "MANUAL_RECTANGLE" as const,
      targetId: "manual-box-1",
      action: "ADD_MANUAL" as const,
      before: null,
      after: {
        entityType: "PATIENT_NAME",
        entityRole: "PATIENT",
        box: {
          pageId: "document-1-P0001",
          x: 20,
          y: 30,
          width: 100,
          height: 24,
        },
        selectionState: "SELECTED" as const,
        selectionSource: "MANUAL_RECTANGLE" as const,
      },
    };

    await expect(
      saveMedicalRedactReviewAction("batch-1", action),
    ).resolves.toBe(updated);
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/medical-redact/batches/batch-1/review-actions",
      action,
    );
  });
});
