import { test, expect } from "@app/tests/helpers/stub-test-base";
import { installTauri } from "@app/tests/helpers/tauriDiskStub";
import fs from "node:fs";
import path from "node:path";

test.use({ autoGoto: false });
test.describe.configure({ mode: "serial", timeout: 120_000 });

const FIXTURES = path.resolve(
  "src/editor/core/tests/test-fixtures/medical-redact",
);
const OUTPATIENT = path.join(FIXTURES, "01_outpatient_record_text.pdf");
const IMAGING = path.join(FIXTURES, "04_imaging_report_scan.png");
const LAB_PDF = path.join(FIXTURES, "03_lab_report_text.pdf");
const WORD = path.join(FIXTURES, "07_outpatient_record_word.docx");

const batch = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "E2E 病历脱敏",
  sourceType: "FILES",
  createdAt: "2026-10-24T02:00:00Z",
  status: "IMPORTED",
  documentCount: 2,
  processedCount: 0,
  reviewRequiredCount: 0,
  blockedCount: 0,
  sourceHash: "a".repeat(64),
  reviewActions: [],
  verificationReports: [],
  documents: [
    {
      id: "doc-pdf",
      batchId: "11111111-1111-4111-8111-111111111111",
      originalFilename: "01_outpatient_record_text.pdf",
      sourceRelativePath: "source/batch/doc-pdf.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
      sha256: "b".repeat(64),
      fileSize: fs.statSync(OUTPATIENT).size,
      pageCount: 2,
      documentType: "outpatient_record",
      status: "IMPORTED",
      processingVersion: "p0",
      pages: [
        {
          id: "doc-pdf-P0001",
          documentId: "doc-pdf",
          pageNo: 1,
          width: 595,
          height: 842,
          sourceKind: "PDF",
          rotation: 0,
          renderDpi: null,
          status: "IMPORTED",
        },
        {
          id: "doc-pdf-P0002",
          documentId: "doc-pdf",
          pageNo: 2,
          width: 595,
          height: 842,
          sourceKind: "PDF",
          rotation: 0,
          renderDpi: null,
          status: "IMPORTED",
        },
      ],
    },
    {
      id: "doc-png",
      batchId: "11111111-1111-4111-8111-111111111111",
      originalFilename: "04_imaging_report_scan.png",
      sourceRelativePath: "source/batch/doc-png.png",
      fileType: "png",
      mimeType: "image/png",
      sha256: "c".repeat(64),
      fileSize: fs.statSync(IMAGING).size,
      pageCount: 1,
      documentType: "imaging_report",
      status: "IMPORTED",
      processingVersion: "p0",
      pages: [
        {
          id: "doc-png-P0001",
          documentId: "doc-png",
          pageNo: 1,
          width: 1400,
          height: 1800,
          sourceKind: "IMAGE",
          rotation: 0,
          renderDpi: null,
          status: "IMPORTED",
        },
      ],
    },
  ],
};

async function expectNoVisibleRawProtocolCodes(
  page: import("@playwright/test").Page,
) {
  const rawProtocolPattern =
    /PATIENT_NAME|PDF_TEXT|PADDLE_OCR|Verification|BLOCKED|LOCAL_REOCR_[A-Z0-9_]+|KNOWN_VALUE_SURVIVED|OUTPUT_OCR_UNAVAILABLE|UNRESOLVED_PII_RISK|Secure-raster|Unable to|not found|unavailable/i;
  expect(await page.locator("body").innerText()).not.toMatch(
    rawProtocolPattern,
  );

  const ariaLabels = await page.locator("[aria-label]").evaluateAll((nodes) =>
    nodes
      .map((node) => node.getAttribute("aria-label") ?? "")
      .filter(Boolean)
      .join("\n"),
  );
  expect(ariaLabels).not.toMatch(rawProtocolPattern);
}

function makeRegions(
  documentId: string,
  pageId: string,
  source: "PDF_TEXT" | "PADDLE_OCR",
  count = 1,
) {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) {
      return {
        id: source === "PADDLE_OCR" ? "ocr-region-1" : "text-region-1",
        documentId,
        pageId,
        tokenIds: [source === "PADDLE_OCR" ? "ocr-token-1" : "token-1"],
        polygon: [
          { x: 80, y: 100 },
          { x: 220, y: 100 },
          { x: 220, y: 124 },
          { x: 80, y: 124 },
        ],
        source,
        confidence: source === "PADDLE_OCR" ? 0.99 : 1,
        selectionState: "UNSELECTED",
        selectionSource: "NONE",
      };
    }
    const column = index % 20;
    const row = Math.floor(index / 20);
    const x = 40 + column * 25;
    const y = 60 + row * 18;
    return {
      id: `${source === "PADDLE_OCR" ? "ocr" : "text"}-region-${index + 1}`,
      documentId,
      pageId,
      tokenIds: [`token-${index + 1}`],
      polygon: [
        { x, y },
        { x: x + 20, y },
        { x: x + 20, y: y + 14 },
        { x, y: y + 14 },
      ],
      source,
      confidence: source === "PADDLE_OCR" ? 0.95 : 1,
      selectionState: "UNSELECTED",
      selectionSource: "NONE",
    };
  });
}

async function installMedicalApiStubs(
  page: import("@playwright/test").Page,
  counters: {
    create: number;
    import: number;
    list: number;
    source: number;
    review: number;
    finalize: number;
    output: number;
  },
  reviewActions: Record<string, unknown>[] = [],
  servedBatch: Record<string, unknown> = batch,
  pdfRegionCount = 1,
  pdfAutoPii = false,
  pdfAutoEntityType = "PHONE",
  pdfAutoEntityRole: string | null = null,
  pdfAutoDetector = "presidio-cn-mobile-phone",
  pdfAutoPolicy: "AUTO_SELECT" | "REVIEW" | "KEEP" = "AUTO_SELECT",
  pdfAutoRiskStatus:
    | "RESOLVED"
    | "REVIEW"
    | "CONFLICT"
    | "HIGH_RISK"
    | "UNRESOLVED" = "RESOLVED",
  pdfAutoConflict = false,
  pdfAlignmentNeedsLocalReocr = false,
  finalizeFindingCodes: string[] = [],
  deliveryFailOnce = false,
  listFailuresBeforeSuccess = 0,
) {
  const deliveryBatchId =
    typeof servedBatch.id === "string" ? servedBatch.id : batch.id;
  let deliveryAttempts = 0;
  let deliveryRecord = {
    batchId: deliveryBatchId,
    status: "NOT_DELIVERED",
    packageId: null,
    profileId: null,
    archiveFilename: null,
    archiveRelativePath: null,
    packageSha256: null,
    archiveSha256: null,
    encryptionAlgorithm: null,
    documentCount: 0,
    remotePath: null,
    createdAt: null,
    completedAt: null,
    lastErrorCode: null,
  };

  await page.route(
    "**/api/v1/medical-redact/runtime/capabilities",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
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
          availableRuntimes: ["CPU", "COREML"],
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
        }),
      });
    },
  );

  await page.route("**/api/v1/medical-redact/batches", async (route) => {
    if (route.request().method() === "POST") {
      counters.create++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...servedBatch,
          status: "CREATED",
          documents: [],
        }),
      });
      return;
    }
    counters.list++;
    if (counters.list <= listFailuresBeforeSuccess) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "MR-RUNTIME-9001", severity: "ERROR" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([servedBatch]),
    });
  });

  await page.route(
    "**/api/v1/medical-redact/batches/*/documents",
    async (route) => {
      counters.import++;
      const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
      expect(body).toContain("01_outpatient_record_text.pdf");
      expect(body).toContain("04_imaging_report_scan.png");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(servedBatch),
      });
    },
  );

  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/doc-pdf/review",
    async (route) => {
      counters.source++;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: fs.readFileSync(OUTPATIENT),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/doc-png/review",
    async (route) => {
      counters.source++;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: fs.readFileSync(LAB_PDF),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/doc-pdf/text-regions",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documentId: "doc-pdf",
          engineAvailable: false,
          piiAvailable: pdfAutoPii,
          piiCandidates: pdfAutoPii
            ? [
                {
                  id: "pii-phone-1",
                  entityType: pdfAutoEntityType,
                  entityRole: pdfAutoEntityRole,
                  normalizedStart: 0,
                  normalizedEnd: 11,
                  sourceStart: 0,
                  sourceEnd: 11,
                  confidence: 0.96,
                  overallConfidence: pdfAlignmentNeedsLocalReocr ? 0.65 : 0.96,
                  detector: pdfAutoDetector,
                  detectorEvidence: [pdfAutoDetector],
                  pageIds: ["doc-pdf-P0001"],
                  tokenIds: ["token-1"],
                  alignment: {
                    level: pdfAlignmentNeedsLocalReocr ? "C" : "A",
                    confidence: pdfAlignmentNeedsLocalReocr ? 0.65 : 1,
                    method: pdfAlignmentNeedsLocalReocr
                      ? "TOKEN_PARTIAL"
                      : "PDF_NATIVE_CHAR",
                    polygons: [
                      {
                        pageId: "doc-pdf-P0001",
                        points: [
                          { x: 90, y: 104 },
                          { x: 180, y: 104 },
                          { x: 180, y: 120 },
                          { x: 90, y: 120 },
                        ],
                      },
                    ],
                    warnings: pdfAlignmentNeedsLocalReocr
                      ? ["PARTIAL_TOKEN_NEEDS_REOCR"]
                      : [],
                    needsLocalReocr: pdfAlignmentNeedsLocalReocr,
                    unresolved: false,
                  },
                  policy: pdfAutoPolicy,
                  riskStatus: pdfAutoRiskStatus,
                  conflict: pdfAutoConflict,
                },
              ]
            : [],
          pages: [
            {
              pageId: "doc-pdf-P0001",
              pageNo: 1,
              mode: "PDF_TEXT",
              tokens: [],
              warningCode: null,
              elapsedMs: 2,
              regions: makeRegions(
                "doc-pdf",
                "doc-pdf-P0001",
                "PDF_TEXT",
                pdfRegionCount,
              ).map((region, index) =>
                pdfAutoPii &&
                pdfAutoPolicy === "AUTO_SELECT" &&
                pdfAutoRiskStatus === "RESOLVED" &&
                !pdfAutoConflict &&
                !pdfAlignmentNeedsLocalReocr &&
                index === 0
                  ? {
                      ...region,
                      selectionState: "SELECTED",
                      selectionSource: "PII_AUTO",
                    }
                  : region,
              ),
            },
            {
              pageId: "doc-pdf-P0002",
              pageNo: 2,
              mode: "PDF_TEXT",
              tokens: [],
              regions: [],
              warningCode: null,
              elapsedMs: 1,
            },
          ],
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/doc-png/text-regions",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documentId: "doc-png",
          engineAvailable: true,
          piiAvailable: false,
          piiCandidates: [],
          pages: [
            {
              pageId: "doc-png-P0001",
              pageNo: 1,
              mode: "PADDLE_OCR",
              tokens: [
                {
                  id: "ocr-token-1",
                  text: "测试患者甲",
                  pageId: "doc-png-P0001",
                  polygon: [
                    { x: 80, y: 100 },
                    { x: 220, y: 100 },
                    { x: 220, y: 124 },
                    { x: 80, y: 124 },
                  ],
                  confidence: 0.99,
                  lineId: "doc-png-P0001-L0001",
                  blockId: "doc-png-P0001-B0001",
                  source: "PADDLE_OCR",
                  charBoxes: null,
                },
              ],
              regions: makeRegions("doc-png", "doc-png-P0001", "PADDLE_OCR"),
              warningCode: null,
              elapsedMs: 12,
            },
          ],
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/review-actions",
    async (route) => {
      counters.review++;
      const action = route.request().postDataJSON() as Record<string, unknown>;
      reviewActions.push(action);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...servedBatch,
          status: "IN_REVIEW",
          reviewActions,
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/*/finalize*",
    async (route) => {
      counters.finalize++;
      const verificationEnabled =
        new URL(route.request().url()).searchParams.get("verify") !== "false";
      const blocked = verificationEnabled && finalizeFindingCodes.length > 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...servedBatch,
          status: blocked ? "BLOCKED" : "VERIFIED",
          reviewActions,
          verificationReports: [
            {
              id: "verification-1",
              documentId: "doc-pdf",
              status: blocked
                ? "BLOCKED"
                : verificationEnabled
                  ? "PASS"
                  : "SKIPPED",
              findingCount: blocked ? finalizeFindingCodes.length : 0,
              createdAt: "2026-10-26T02:00:00Z",
              outputFilename: blocked ? null : "DOC111111111111-ABCDEF12.pdf",
              outputRelativePath: blocked
                ? null
                : "output/11111111-1111-4111-8111-111111111111/DOC111111111111-ABCDEF12.pdf",
              sha256: blocked ? null : "d".repeat(64),
              fileSize: blocked ? 0 : 1024,
              pageCount: 2,
              issues: blocked
                ? finalizeFindingCodes.map((code) => ({
                    code:
                      code === "KNOWN_VALUE_SURVIVED"
                        ? "MR-VERIFY-7004"
                        : code === "OUTPUT_OCR_UNAVAILABLE"
                          ? "MR-VERIFY-7006"
                          : "MR-VERIFY-7099",
                    severity: "BLOCKING",
                    params:
                      code === "KNOWN_VALUE_SURVIVED"
                        ? {
                            pageNo: 1,
                            entityType: "PATIENT_NAME",
                            x: 90,
                            y: 104,
                            width: 90,
                            height: 16,
                          }
                        : {},
                    pageId:
                      code === "KNOWN_VALUE_SURVIVED" ? "doc-pdf-P0001" : null,
                    candidateId:
                      code === "KNOWN_VALUE_SURVIVED"
                        ? "verification-known-value-1"
                        : null,
                  }))
                : [],
            },
          ],
        }),
      });
    },
  );
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/*/output",
    async (route) => {
      counters.output++;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: fs.readFileSync(OUTPATIENT),
      });
    },
  );

  await page.route(
    "**/api/v1/medical-redact/delivery/test-connection",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );

  await page.route(
    "**/api/v1/medical-redact/batches/*/delivery",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(deliveryRecord),
        });
        return;
      }

      deliveryAttempts++;
      if (deliveryFailOnce && deliveryAttempts === 1) {
        deliveryRecord = {
          ...deliveryRecord,
          status: "UPLOAD_FAILED",
          packageId: "e2e-package-id",
          profileId: "default",
          archiveFilename: "PKG-E2E0000000000000001.zip",
          archiveRelativePath:
            "delivery/packages/11111111-1111-4111-8111-111111111111/PKG-E2E0000000000000001.zip",
          packageSha256: "e".repeat(64),
          archiveSha256: "f".repeat(64),
          encryptionAlgorithm: "ZIP-AES-256",
          documentCount: 2,
          createdAt: "2026-10-28T08:00:00Z",
          lastErrorCode: "MR-DELIVERY-8511",
        };
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            code: "MR-DELIVERY-8511",
            severity: "ERROR",
            params: {},
            traceId: "delivery-e2e-failure",
          }),
        });
        return;
      }

      deliveryRecord = {
        ...deliveryRecord,
        status: "UPLOADED",
        packageId: "e2e-package-id",
        profileId: "default",
        archiveFilename: "PKG-E2E0000000000000001.zip",
        archiveRelativePath:
          "delivery/packages/11111111-1111-4111-8111-111111111111/PKG-E2E0000000000000001.zip",
        packageSha256: "e".repeat(64),
        archiveSha256: "f".repeat(64),
        encryptionAlgorithm: "ZIP-AES-256",
        documentCount: 2,
        remotePath: "/incoming/PKG-E2E0000000000000001.zip",
        createdAt: "2026-10-28T08:00:00Z",
        completedAt: "2026-10-28T08:00:10Z",
        lastErrorCode: null,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(deliveryRecord),
      });
    },
  );
}

test("medical desktop creates a batch from synthetic PDF + PNG and enters Redact", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page).toHaveTitle("中文医疗资料自动脱敏");
  await expect(page.getByText("Source SHA256", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Stirling PDF/i)).toHaveCount(0);
  await expect(page.getByText(/Make Stirling/i)).toHaveCount(0);
  await expect(page.getByText(/Open every PDF in Stirling/i)).toHaveCount(0);
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();

  const taskDialog = page.getByRole("dialog");
  await expect(taskDialog.getByText("新建脱敏任务")).toBeVisible();
  await taskDialog.getByLabel("任务名称").fill("E2E 病历脱敏");
  await taskDialog.getByRole("button", { name: "选择文件" }).click();

  const fileInput = page.locator('input[type="file"][accept]').first();
  await expect(fileInput).toHaveAttribute(
    "accept",
    ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp",
  );
  await fileInput.setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  await expect(page).toHaveURL(/\/redact$/);
  await expect.poll(() => counters.create, { timeout: 20_000 }).toBe(1);
  expect(counters.import).toBe(1);

  await expect(page.locator("[data-medical-review-workspace]")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "脱敏审核" })).toBeVisible();
  await expect(page.getByText("PDF Tools", { exact: true })).toHaveCount(0);
  await expect(page.getByText("PDF Library", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Page Editor", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Active Files", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-medical-document-list]")).toContainText(
    "01_outpatient_record_text.pdf",
  );
  await expect(page.locator("[data-medical-document-list]")).toContainText(
    "04_imaging_report_scan.png",
  );
  await expect(page.locator("[data-medical-viewer-toolbar]")).toBeVisible();
  for (const label of [
    "第一页",
    "上一页",
    "下一页",
    "最后一页",
    "缩小",
    "放大",
    "适合宽度",
    "适合页面",
  ]) {
    await expect(page.getByLabel(label)).toBeVisible();
  }
  await expectNoVisibleRawProtocolCodes(page);
  await expect(page.getByRole("button", { name: /Print/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Save As/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Share/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Dual Page/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Dark Filter/i })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "返回任务中心" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
});

test("medical desktop startup lists persisted tasks and resumes them without creating a new task", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("E2E 病历脱敏", { exact: true })).toBeVisible();
  await expect(page.locator("[data-medical-task-center]")).toContainText(
    "2 个文件",
  );
  await expect
    .poll(() => counters.list, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(counters.create).toBe(0);
  expect(counters.import).toBe(0);

  await page.getByRole("button", { name: "继续审核" }).click();
  await expect(page).toHaveURL(/\/redact$/);
  await expect(page.getByRole("heading", { name: "脱敏审核" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-medical-document-list]")).toContainText(
    "01_outpatient_record_text.pdf",
  );
  await expect(page.locator("[data-medical-document-list]")).toContainText(
    "04_imaging_report_scan.png",
  );
  expect(counters.create).toBe(0);
  expect(counters.import).toBe(0);
});

test("medical desktop retries initial persisted-task loading until the backend is ready", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: -2,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("正在读取本地任务…")).toBeVisible();
  await expect(page.getByText("E2E 病历脱敏", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-medical-task-center]")).toContainText(
    "2 个文件",
  );
  expect(counters.list).toBe(1);
  await expect(page).toHaveURL(/\/$/);
});

test("medical desktop recovers direct review-route startup without an active session", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch);

  await page.goto("/redact", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("E2E 病历脱敏", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("medical desktop keeps task center usable when persisted source recovery fails", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch);
  await page.route(
    "**/api/v1/medical-redact/batches/*/documents/doc-pdf/review",
    async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          code: "MR-STORAGE-9503",
          severity: "ERROR",
          params: {},
        }),
      });
    },
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "继续审核" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("本地任务操作失败")).toBeVisible();
  await expect(page.getByRole("button", { name: "继续审核" })).toBeEnabled();
});

test("medical review blocks residual context-menu and generic-tool navigation", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "继续审核" }).click();
  await expect(page).toHaveURL(/\/redact$/);
  const firstPage = page.locator('[data-page-index="0"]').first();
  await expect(firstPage).toBeVisible({ timeout: 30_000 });

  const pageBox = await firstPage.boundingBox();
  if (!pageBox) throw new Error("Page wrapper has no bounding box");
  await page.mouse.click(
    pageBox.x + pageBox.width * 0.5,
    pageBox.y + pageBox.height * 0.3,
    { button: "right" },
  );
  await expect(page).toHaveURL(/\/redact$/);
  await expect(page.locator("[data-text-selection-menu]")).toHaveCount(0);

  await page.evaluate(() => {
    window.history.pushState({}, "", "/annotate");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/redact$/);
  await expect(page.locator("[data-medical-review-workspace]")).toBeVisible();

  for (const shortcut of ["Meta+P", "Meta+S", "Meta+F", "Meta+R"]) {
    await page.keyboard.press(shortcut);
    await expect(page).toHaveURL(/\/redact$/);
  }
});

test("medical desktop redirects generic Stirling routes back to tasks", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters);

  for (const pathName of ["/automate", "/files", "/compress-pdf"]) {
    await page.goto(pathName, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
    await expect(page.getByText("PDF Tools", { exact: true })).toHaveCount(0);
    await expect(page.getByText("PDF Library", { exact: true })).toHaveCount(0);
  }
});

test("medical settings expose only medical-redaction controls", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters);

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-medical-settings]")).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行环境" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "脱敏设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "交付服务器" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "隐私保护" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "存储与维护" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "关于" })).toBeVisible();
  await expect(page.getByText("黑色（固定，不可修改）")).toBeVisible();
  const securityVerificationSwitch = page.getByRole("switch", {
    name: "安全验证",
  });
  await expect(securityVerificationSwitch).toBeVisible();
  await expect(securityVerificationSwitch).toBeChecked();
  await expect(
    page.getByText(/开启后，生成时会执行文字残留、PII、黑框覆盖和 PDF/),
  ).toBeVisible();
  await expect(page.getByText("macOS 15.3 · arm64")).toBeVisible();
  await expect(page.getByText("Apple M1 Pro")).toBeVisible();
  await expect(page.getByText("8 个物理核心 / 8 个逻辑核心")).toBeVisible();
  await expect(page.getByText("16 GB")).toBeVisible();
  await expect(page.getByText("Apple Silicon").first()).toBeVisible();
  await expect(page.getByText("当前可用运行时")).toBeVisible();
  await expect(
    page.getByText("CPU、CoreML（Apple Silicon 加速）", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("调度档位")).toBeVisible();
  await expect(page.getByText("标准", { exact: true })).toBeVisible();
  await expect(
    page.getByText("文字识别 1 / 敏感信息识别 1 / 页面预处理 2", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("4 页", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "当前脱敏处理均在本机完成，不会将医疗资料发送到云端大模型服务。",
    ),
  ).toBeVisible();
  await expectNoVisibleRawProtocolCodes(page);

  for (const forbidden of [
    "Stirling Cloud",
    "Self-hosted server",
    "Billing",
    "Team",
    "API Keys",
    "Server Admin",
    "Database",
    "Integrations",
    "Make Stirling",
    "Open every PDF in Stirling",
    "Runtime Probe",
    "Engine sidecar",
    "Workspace",
    "Spring",
    "Desktop medical-redact",
    "P3",
    "P4",
  ]) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }
});

test("security verification can be disabled in settings so generation is not blocked by verification findings", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    reviewActions,
    batch,
    1,
    false,
    "PHONE",
    null,
    "presidio-cn-mobile-phone",
    "AUTO_SELECT",
    "RESOLVED",
    false,
    false,
    ["KNOWN_VALUE_SURVIVED"],
  );

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  const verificationSwitch = page.getByRole("switch", {
    name: "安全验证",
  });
  await expect(verificationSwitch).toBeChecked();
  await verificationSwitch.click({ force: true });
  await expect(verificationSwitch).not.toBeChecked();
  await expect(
    page.getByText(/安全验证已关闭。系统仍会生成 Secure Raster/),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "返回医疗任务中心" }).click();
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);

  await expect(
    page.getByText("安全验证已关闭，将按当前遮挡结果生成脱敏文件。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存并生成脱敏文件" }).click();
  await expect.poll(() => counters.finalize, { timeout: 15_000 }).toBe(1);
  await expect(
    page.getByText("安全验证已关闭，文件已按当前遮挡结果生成，可以直接导出。", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出脱敏文件" }),
  ).toBeEnabled();
  await expect(page.getByText("安全验证未通过", { exact: true })).toHaveCount(
    0,
  );
});

test("P2.8 delivery settings, failure retry, and restart status remain task-scoped", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const completedBatch = {
    ...batch,
    status: "VERIFIED",
    verificationReports: batch.documents.map((document, index) => ({
      id: `verification-delivery-${index + 1}`,
      batchId: batch.id,
      documentId: document.id,
      status: index === 0 ? "PASS" : "SKIPPED",
      outputFilename: `DOC000${index + 1}.pdf`,
      outputRelativePath: `output/${batch.id}/DOC000${index + 1}.pdf`,
      sha256: String(index + 1).repeat(64),
      fileSize: 1024 + index,
      pageCount: document.pageCount,
      issues: [],
    })),
  };

  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    [],
    completedBatch,
    1,
    false,
    "PHONE",
    null,
    "presidio-cn-mobile-phone",
    "AUTO_SELECT",
    "RESOLVED",
    false,
    false,
    [],
    true,
  );

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "交付服务器" })).toBeVisible();

  await page.getByLabel("服务器地址 (Host)").fill("127.0.0.1");
  await page.getByLabel("用户名 (Username)").fill("delivery-user");
  await page.getByLabel("密码", { exact: true }).fill("server-secret-e2e");
  await page
    .getByLabel("SFTP 主机密钥指纹")
    .fill("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await page.getByLabel("交付包加密口令").fill("archive-secret-e2e-123");

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(
    page.getByText("连接成功，可以使用当前服务器进行安全交付。"),
  ).toBeVisible();

  const localStorageDump = await page.evaluate(() =>
    JSON.stringify(Object.fromEntries(Object.entries(localStorage))),
  );
  expect(localStorageDump).not.toContain("server-secret-e2e");
  expect(localStorageDump).not.toContain("archive-secret-e2e-123");

  await page.getByRole("button", { name: "返回医疗任务中心" }).click();
  await expect(page.getByText("交付：未交付", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "打包并上传" }).click();
  await expect(
    page.getByText("上传交付包失败", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重试上传" })).toBeVisible();

  await page.getByRole("button", { name: "重试上传" }).click();
  await expect(page.getByText("交付：已上传", { exact: true })).toBeVisible();
  await expect(
    page.getByText("/incoming/PKG-E2E0000000000000001.zip", {
      exact: false,
    }),
  ).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("交付：已上传", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新上传" })).toBeVisible();
  await expectNoVisibleRawProtocolCodes(page);
});

test("completed tasks expose verified results through the medical review path", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const completedBatch = {
    ...batch,
    status: "VERIFIED",
    verificationReports: batch.documents.map((document, index) => ({
      id: `verification-${index + 1}`,
      batchId: batch.id,
      documentId: document.id,
      status: "PASS",
      outputFilename: `verified-${index + 1}.pdf`,
      pageCount: document.pageCount,
      issues: [],
    })),
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], completedBatch);

  await page.goto("/tasks", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await expect(page.getByText(/verified-1\.pdf/)).toBeVisible();
  await page.getByRole("button", { name: "查看结果" }).click();

  await expect(page).toHaveURL(/\/redact$/);
  await expect(
    page.getByRole("button", { name: "导出已验证脱敏文件" }),
  ).toBeEnabled({ timeout: 30_000 });
  await expectNoVisibleRawProtocolCodes(page);
});

test("P2.0 deterministic PII auto-selects an existing text region and remains deselectable", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(page, counters, reviewActions, batch, 1, true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(counters.review).toBe(0);
  await page.getByRole("button", { name: "自动脱敏" }).click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  await expect(region).toHaveCSS("background-color", "rgb(0, 0, 0)");
  expect(reviewActions[0]).toMatchObject({
    documentId: "doc-pdf",
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "SELECT_TEXT",
    after: {
      entityType: "PHONE",
      selectionState: "SELECTED",
      selectionSource: "PII_AUTO",
      box: {
        pageId: "doc-pdf-P0001",
        x: 90,
        y: 104,
        width: 90,
        height: 16,
      },
    },
  });
  expect(JSON.stringify(reviewActions[0])).not.toContain("13800000001");

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(2);
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(reviewActions[1]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "DESELECT_TEXT",
    after: {
      entityType: "PHONE",
      selectionState: "UNSELECTED",
      selectionSource: "USER",
    },
  });
});

test("P2.1 known/NER entity role auto-selects through the existing review action", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    reviewActions,
    batch,
    1,
    true,
    "PATIENT_NAME",
    "PATIENT",
    "known-entity",
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(counters.review).toBe(0);
  await page.getByRole("button", { name: "自动脱敏" }).click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  expect(reviewActions[0]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "SELECT_TEXT",
    after: {
      entityType: "PATIENT_NAME",
      entityRole: "PATIENT",
      selectionState: "SELECTED",
      selectionSource: "PII_AUTO",
    },
  });
});

test("P2.2 KEEP policy remains unselected while the same region stays manually clickable", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    reviewActions,
    batch,
    1,
    true,
    "HOSPITAL_NAME",
    null,
    "ner-context-hospital-name",
    "KEEP",
    "RESOLVED",
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(counters.review).toBe(0);

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  expect(reviewActions[0]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "SELECT_TEXT",
    after: {
      selectionState: "SELECTED",
      selectionSource: "USER",
    },
  });
});

test("P2.4 high-risk candidate stays in the existing review UI and records explicit approval", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    reviewActions,
    batch,
    1,
    true,
    "PHONE",
    "PATIENT",
    "presidio-cn-mobile-phone",
    "REVIEW",
    "HIGH_RISK",
    false,
    true,
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const risk = page.locator('[data-risk-candidate="pii-phone-1"]');
  await expect(risk).toBeVisible({ timeout: 30_000 });
  await expect(risk).toHaveAttribute("data-risk-status", "HIGH_RISK");
  await expect(risk).toContainText("高风险");
  await expect(risk).toContainText("手机 · 患者");
  await expect(risk).toContainText("识别置信度");
  await expect(risk).toContainText("定位置信度");
  await expect(risk).toContainText(
    "当前只定位到敏感信息的一部分。请执行局部重新识别或人工补框。",
  );
  await expect(risk).not.toContainText("presidio-cn-mobile-phone");
  await expect(risk).not.toContainText("TOKEN_PARTIAL");
  await expect(risk).not.toContainText("PARTIAL_TOKEN_NEEDS_REOCR");
  await expectNoVisibleRawProtocolCodes(page);
  await expect(page.getByRole("button", { name: "下一风险" })).toBeEnabled();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toHaveAttribute("data-selected", "false");
  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  await expect(page.getByText("人工文字 1", { exact: true })).toBeVisible();

  await risk.getByRole("button", { name: "批准" }).click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(2);
  expect(reviewActions[1]).toMatchObject({
    documentId: "doc-pdf",
    targetType: "PII_CANDIDATE",
    targetId: "pii-phone-1",
    action: "APPROVE",
    after: {
      entityType: "PHONE",
      entityRole: "PATIENT",
      box: null,
      selectionState: "UNSELECTED",
      selectionSource: "NONE",
    },
  });
  await expect(risk).toContainText("已批准");
});

test("P2.5 Verification finding blocks export and exposes the fail-closed reason", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(
    page,
    counters,
    reviewActions,
    batch,
    1,
    false,
    "PHONE",
    null,
    "presidio-cn-mobile-phone",
    "AUTO_SELECT",
    "RESOLVED",
    false,
    false,
    ["KNOWN_VALUE_SURVIVED"],
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);

  const exportButton = page.getByRole("button", {
    name: "导出已验证脱敏文件",
  });
  await expect(exportButton).toBeDisabled();
  await page.getByRole("button", { name: "保存并生成脱敏文件" }).click();

  await expect.poll(() => counters.finalize, { timeout: 15_000 }).toBe(1);
  await expect(
    page.locator('[data-medical-redact-verification="BLOCKED"]'),
  ).toContainText("安全验证未通过");
  await expect(page.locator("[data-verification-findings]")).toContainText(
    "第 1 页 · 患者姓名 · 区域 (90, 104, 90×16)",
  );
  await expect(page.locator("[data-verification-findings]")).toContainText(
    "仍检测到已知敏感信息",
  );
  await page.getByRole("button", { name: "定位该区域" }).click();
  await expect(
    page.locator("[data-medical-redact-verification-focus]"),
  ).toBeVisible();
  await expectNoVisibleRawProtocolCodes(page);
  await expect(exportButton).toBeDisabled();
  expect(counters.output).toBe(0);
});

test("native PDF text regions click-select and click-deselect through review actions", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(page, counters, reviewActions);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const region = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveAttribute("data-selected", "false");
  const unselectedBounds = await region.boundingBox();
  if (!unselectedBounds) throw new Error("Text region has no bounding box");

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  await expect(region).toHaveAttribute("data-medical-redact-padding", "2");
  await expect(region).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const selectedBounds = await region.boundingBox();
  if (!selectedBounds) {
    throw new Error("Selected text region has no bounding box");
  }
  expect(selectedBounds.x).toBeLessThan(unselectedBounds.x);
  expect(selectedBounds.y).toBeLessThan(unselectedBounds.y);
  expect(selectedBounds.width).toBeGreaterThan(unselectedBounds.width);
  expect(selectedBounds.height).toBeGreaterThan(unselectedBounds.height);
  expect(reviewActions[0]).toMatchObject({
    documentId: "doc-pdf",
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "SELECT_TEXT",
    after: {
      selectionState: "SELECTED",
      selectionSource: "USER",
    },
  });

  const undoButton = page.getByRole("button", { name: "撤销" });
  const redoButton = page.getByRole("button", { name: "重做" });
  await expect(undoButton).toBeEnabled();
  await undoButton.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(2);
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(reviewActions[1]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "DESELECT_TEXT",
    before: { selectionState: "SELECTED" },
    after: { selectionState: "UNSELECTED" },
  });

  await expect(redoButton).toBeEnabled();
  await redoButton.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(3);
  await expect(region).toHaveAttribute("data-selected", "true");
  expect(reviewActions[2]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "SELECT_TEXT",
    after: { selectionState: "SELECTED" },
  });

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(4);
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(reviewActions[3]).toMatchObject({
    targetType: "TEXT_REGION",
    targetId: "text-region-1",
    action: "DESELECT_TEXT",
    after: { selectionState: "UNSELECTED" },
  });
});

test("PaddleOCR text regions use the same click interaction and stay aligned after zoom", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(page, counters, reviewActions);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const imagingFile = page.getByRole("button", {
    name: "打开任务文件 doc-png.pdf",
  });
  await expect(imagingFile).toBeVisible({ timeout: 30_000 });
  await imagingFile.click();

  const region = page.locator(
    '[data-medical-redact-text-region="ocr-region-1"]',
  );
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveAttribute("data-selected", "false");

  const beforeZoom = await region.boundingBox();
  if (!beforeZoom) throw new Error("OCR region has no bounding box");
  await page.getByRole("button", { name: "放大" }).first().click();
  await expect
    .poll(async () => (await region.boundingBox())?.width ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(beforeZoom.width);
  const afterZoom = await region.boundingBox();
  if (!afterZoom) throw new Error("OCR region vanished after zoom");
  expect(afterZoom.width / beforeZoom.width).toBeGreaterThan(1.05);

  const thumbnailToggle = page.getByRole("button", { name: "页面缩略图" });
  await thumbnailToggle.click();
  await expect(thumbnailToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sidebar-base")).toBeVisible();

  await page.getByRole("button", { name: "适合宽度" }).click();
  await expect(region).toBeVisible();
  const afterFitWidth = await region.boundingBox();
  if (!afterFitWidth) throw new Error("OCR region vanished after fit-width");
  expect(afterFitWidth.width).toBeGreaterThan(0);

  await page.getByRole("button", { name: "适合页面" }).click();
  await expect(region).toBeVisible();
  const afterFitPage = await region.boundingBox();
  if (!afterFitPage) throw new Error("OCR region vanished after fit-page");
  expect(afterFitPage.width).toBeGreaterThan(0);

  await thumbnailToggle.click();
  await expect(thumbnailToggle).toHaveAttribute("aria-pressed", "false");

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  await expect(region).toHaveAttribute("data-selected", "true");
  await expect(region).toHaveCSS("background-color", "rgb(0, 0, 0)");
  expect(reviewActions[0]).toMatchObject({
    documentId: "doc-png",
    targetType: "TEXT_REGION",
    targetId: "ocr-region-1",
    action: "SELECT_TEXT",
    after: {
      selectionState: "SELECTED",
      selectionSource: "USER",
    },
  });

  await region.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(2);
  await expect(region).toHaveAttribute("data-selected", "false");
  expect(reviewActions[1]).toMatchObject({
    documentId: "doc-png",
    targetType: "TEXT_REGION",
    targetId: "ocr-region-1",
    action: "DESELECT_TEXT",
    after: { selectionState: "UNSELECTED" },
  });
});

test("large text-region pages render progressively without dropping clickable regions", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], batch, 800);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const layer = page.locator("[data-medical-redact-text-layer]").first();
  await expect(layer).toBeVisible({ timeout: 30_000 });
  await expect(layer).toHaveAttribute(
    "data-medical-redact-region-count",
    "800",
  );
  await expect(layer).toHaveAttribute(
    "data-medical-redact-render-batch",
    "250",
  );
  await expect
    .poll(
      async () =>
        Number(
          await layer.getAttribute("data-medical-redact-rendered-region-count"),
        ),
      { timeout: 10_000 },
    )
    .toBe(800);
  await expect(
    page.locator('[data-medical-redact-text-region="text-region-800"]'),
  ).toBeVisible();
});

test("persisted batch reloads its synthetic source files after restart", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const restoredState = {
    entityType: "PATIENT_NAME",
    entityRole: "PATIENT",
    box: {
      pageId: "doc-pdf-P0001",
      x: 80,
      y: 100,
      width: 140,
      height: 24,
    },
    selectionState: "SELECTED",
    selectionSource: "MANUAL_RECTANGLE",
  };
  const persistedBatch = {
    ...batch,
    status: "IN_REVIEW",
    reviewActions: [
      {
        id: "review-action-1",
        documentId: "doc-pdf",
        targetType: "MANUAL_RECTANGLE",
        targetId: "persisted-candidate-1",
        action: "ADD_MANUAL",
        before: null,
        after: restoredState,
        operatorId: "local-user",
        createdAt: "2026-10-26T00:00:00Z",
      },
      {
        id: "review-action-2",
        documentId: "doc-pdf",
        targetType: "TEXT_REGION",
        targetId: "text-region-1",
        action: "SELECT_TEXT",
        before: null,
        after: {
          ...restoredState,
          selectionSource: "USER",
        },
        operatorId: "local-user",
        createdAt: "2026-10-26T00:00:01Z",
      },
    ],
  };
  await installTauri(page);
  await installMedicalApiStubs(page, counters, [], persistedBatch);

  await page.goto("/tasks", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("E2E 病历脱敏")).toBeVisible();
  await expect(page.getByText(/2 个文件 · 3 页/)).toBeVisible();

  await page.getByRole("button", { name: "继续审核" }).click();

  await expect(page).toHaveURL(/\/redact$/);
  await expect.poll(() => counters.source, { timeout: 20_000 }).toBe(2);
  await expect(page.getByRole("heading", { name: "脱敏审核" })).toBeVisible({
    timeout: 30_000,
  });
  const restoredTextRegion = page.locator(
    '[data-medical-redact-text-region="text-region-1"]',
  );
  await expect(restoredTextRegion).toBeVisible({ timeout: 15_000 });
  await expect(restoredTextRegion).toHaveAttribute("data-selected", "true");
  await expect(restoredTextRegion).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  expect(counters.review).toBe(0);
});

test("P0 desktop explicitly excludes DOCX from the import picker", async ({
  page,
}) => {
  await installTauri(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();

  const fileInput = page.locator('input[type="file"][accept]').first();
  const accept = await fileInput.getAttribute("accept");
  expect(accept).not.toContain(".docx");
  expect(fs.existsSync(WORD)).toBe(true);
});

test("manual redaction persists a typed review action without raw text", async ({
  page,
}) => {
  const counters = {
    create: 0,
    import: 0,
    list: 0,
    source: 0,
    review: 0,
    finalize: 0,
    output: 0,
  };
  const reviewActions: Record<string, unknown>[] = [];
  await installTauri(page);
  await installMedicalApiStubs(page, counters, reviewActions);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "选择文件" })
    .click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: "添加 2 个文件" }).click();

  const firstPage = page.locator('[data-page-index="0"]').first();
  await expect(firstPage).toBeVisible({ timeout: 30_000 });
  await expect(firstPage.locator(".pdf-selection-layer")).toBeAttached({
    timeout: 15_000,
  });
  await expect(
    page.locator('[data-medical-redact-editing-ready="false"]'),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "手工补框" }).click();
  const editingControls = page.locator(
    '[data-medical-redact-editing-ready="true"]',
  );
  await expect(editingControls).toBeVisible({ timeout: 15_000 });

  const box = await firstPage.boundingBox();
  if (!box) throw new Error("Page wrapper has no bounding box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.32, {
    steps: 15,
  });
  await page.mouse.up();

  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(1);
  expect(reviewActions[0]).toMatchObject({
    action: "ADD_MANUAL",
    documentId: "doc-pdf",
    targetType: "MANUAL_RECTANGLE",
    targetId: expect.any(String),
    after: {
      selectionState: "SELECTED",
      selectionSource: "MANUAL_RECTANGLE",
    },
  });
  expect(JSON.stringify(reviewActions[0])).not.toContain("张三");

  const undoButton = page.getByRole("button", { name: "撤销" });
  const redoButton = page.getByRole("button", { name: "重做" });
  await expect(undoButton).toBeEnabled();
  await undoButton.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(2);
  expect(reviewActions[1]).toMatchObject({ action: "DELETE_MANUAL" });

  await expect(redoButton).toBeEnabled();
  await redoButton.click();
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(3);
  expect(reviewActions[2]).toMatchObject({ action: "ADD_MANUAL" });

  const entityType = page.getByLabel("敏感类型");
  await expect(entityType).toBeVisible({ timeout: 10_000 });
  await entityType.selectOption("PATIENT_NAME");
  await expect.poll(() => counters.review, { timeout: 15_000 }).toBe(4);
  expect(reviewActions[3]).toMatchObject({
    action: "CHANGE_TYPE",
    after: { entityType: "PATIENT_NAME", entityRole: "PATIENT" },
  });

  await page.getByText("当前脱敏任务", { exact: true }).click();
  await expect(page.getByLabel("敏感类型")).toHaveCount(0);

  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.285);
  await expect(page.getByLabel("敏感类型")).toBeVisible({ timeout: 10_000 });

  const previewButton = page.getByRole("button", {
    name: "最终黑框预览",
  });
  await expect(previewButton).toBeEnabled();
  await previewButton.click();

  const previewBox = firstPage.locator("[data-medical-redact-preview-box]");
  await expect(previewBox).toHaveCount(1);
  await expect(previewBox).toHaveAttribute("data-medical-redact-padding", "2");
  await expect(previewBox).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(
    page.getByRole("button", { name: "退出最终预览" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('[data-medical-redact-editing-ready="false"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Apply Redactions/ }),
  ).toHaveCount(0);
  expect(counters.review).toBe(4);

  await page.getByRole("button", { name: "退出最终预览" }).click();
  await expect(previewBox).toHaveCount(0);
  await expect(previewButton).toHaveAttribute("aria-pressed", "false");
  expect(counters.review).toBe(4);

  const exportButton = page.getByRole("button", {
    name: "导出已验证脱敏文件",
  });
  await expect(exportButton).toBeDisabled();

  const finalizeButton = page.getByRole("button", {
    name: "保存并生成脱敏文件",
  });
  await expect(finalizeButton).toBeEnabled();
  await finalizeButton.click();
  await expect.poll(() => counters.finalize, { timeout: 15_000 }).toBe(1);
  await expect(
    page.getByText("安全验证通过，可以导出脱敏文件。", { exact: true }),
  ).toHaveCount(0);
  await expectNoVisibleRawProtocolCodes(page);
  await expect(exportButton).toBeEnabled();
});
