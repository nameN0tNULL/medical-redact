import { expect, test } from "@playwright/test";
import {
  bypassOnboarding,
  mockAppApis,
  seedCookieConsent,
} from "@app/tests/helpers/api-stubs";
import { installTauri } from "@app/tests/helpers/tauriDiskStub";
import fs from "node:fs";
import path from "node:path";

test.use({ viewport: { width: 1920, height: 1080 } });

const BACKEND_PORT = Number(process.env.MEDICAL_REDACT_LIVE_BACKEND_PORT ?? 0);
const FIXTURES = path.resolve(
  "src/editor/core/tests/test-fixtures/medical-redact",
);
const OUTPATIENT = path.join(FIXTURES, "01_outpatient_record_text.pdf");
const IMAGING = path.join(FIXTURES, "04_imaging_report_scan.png");

interface LiveBatch {
  id: string;
  name: string;
  documents: Array<{ id: string; originalFilename: string }>;
  reviewActions: Array<{
    targetType: string;
    targetId: string;
    action: string;
    before: unknown;
    after: unknown;
  }>;
  verificationReports: Array<{ documentId: string; status: string }>;
}

async function newestBatch(
  request: import("@playwright/test").APIRequestContext,
  baseUrl: string,
  taskName: string,
): Promise<LiveBatch> {
  const response = await request.get(
    baseUrl + "/api/v1/medical-redact/batches",
  );
  expect(response.ok()).toBe(true);
  const batches = (await response.json()) as LiveBatch[];
  const found = batches.find((item) => item.name === taskName);
  if (!found) throw new Error("Live batch not found: " + taskName);
  return found;
}

test("P1 real desktop -> Spring -> PaddleOCR survives restart and finalizes", async ({
  page,
  request,
}) => {
  test.skip(
    BACKEND_PORT <= 0,
    "MEDICAL_REDACT_LIVE_BACKEND_PORT is required for the real P1 E2E",
  );
  test.setTimeout(180_000);

  const baseUrl = "http://127.0.0.1:" + BACKEND_PORT;
  const taskName = "P1 final live " + Date.now();

  await seedCookieConsent(page);
  await bypassOnboarding(page);
  await mockAppApis(page);
  await installTauri(page, { backendPort: BACKEND_PORT });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveTitle("中文医疗资料自动脱敏");

  await page.getByRole("button", { name: "新建脱敏任务" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("任务名称").fill(taskName);
  await dialog.getByRole("button", { name: "选择文件" }).click();
  await page
    .locator('input[type="file"][accept]')
    .first()
    .setInputFiles([OUTPATIENT, IMAGING]);
  await page.getByRole("button", { name: /Add 2 files/i }).click();

  await expect(page).toHaveURL(/\/redact$/, { timeout: 60_000 });

  const nativeRegion = page
    .locator("[data-medical-redact-text-region]")
    .first();
  await expect(nativeRegion).toBeVisible({ timeout: 60_000 });
  await nativeRegion.click();
  await expect(nativeRegion).toHaveAttribute("data-selected", "true");

  const undo = page.getByRole("button", { name: "撤销" });
  const redo = page.getByRole("button", { name: "重做" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(nativeRegion).toHaveAttribute("data-selected", "false");
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(nativeRegion).toHaveAttribute("data-selected", "true");

  const batch = await newestBatch(request, baseUrl, taskName);
  const nativeDocument = batch.documents.find(
    (item) => item.originalFilename === "01_outpatient_record_text.pdf",
  );
  const imagingDocument = batch.documents.find(
    (item) => item.originalFilename === "04_imaging_report_scan.png",
  );
  if (!nativeDocument || !imagingDocument) {
    throw new Error("Live imported documents are incomplete");
  }

  const imagingFile = page.getByRole("button", {
    name: "打开任务文件 " + imagingDocument.id + ".pdf",
  });
  await expect(imagingFile).toBeVisible({ timeout: 30_000 });
  await imagingFile.click();

  const ocrRegion = page.locator("[data-medical-redact-text-region]").first();
  await expect(ocrRegion).toBeVisible({ timeout: 90_000 });
  const sourceBeforeZoom = await ocrRegion.boundingBox();
  if (!sourceBeforeZoom) throw new Error("Real OCR region has no bounding box");

  await page.getByRole("button", { name: "Zoom In" }).first().click();
  await expect
    .poll(async () => (await ocrRegion.boundingBox())?.width ?? 0, {
      timeout: 15_000,
    })
    .toBeGreaterThan(sourceBeforeZoom.width);

  const ocrTargetId = await ocrRegion.getAttribute(
    "data-medical-redact-text-region",
  );
  expect(ocrTargetId).toBeTruthy();
  await ocrRegion.click();
  await expect(ocrRegion).toHaveAttribute("data-selected", "true");
  await expect(ocrRegion).toHaveCSS("background-color", "rgb(0, 0, 0)");

  await expect
    .poll(
      async () => {
        const current = await newestBatch(request, baseUrl, taskName);
        return current.reviewActions.filter(
          (action) =>
            action.targetType === "TEXT_REGION" &&
            action.targetId === ocrTargetId &&
            action.action === "SELECT_TEXT",
        ).length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const persistedBeforeRestart = await newestBatch(request, baseUrl, taskName);
  expect(JSON.stringify(persistedBeforeRestart.reviewActions)).not.toContain(
    "测试患者甲",
  );

  await page.goto("/tasks", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(taskName)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "继续审核" }).first().click();
  await expect(page).toHaveURL(/\/redact$/, { timeout: 60_000 });

  const restoredNative = page.locator(
    '[data-medical-redact-text-region][data-selected="true"]',
  );
  await expect(restoredNative.first()).toBeVisible({ timeout: 60_000 });

  const restoredImagingFile = page.getByRole("button", {
    name: "打开任务文件 " + imagingDocument.id + ".pdf",
  });
  await restoredImagingFile.click();

  const restoredOcr = page.locator(
    '[data-medical-redact-text-region="' + ocrTargetId + '"]',
  );
  await expect(restoredOcr).toBeVisible({ timeout: 90_000 });
  await expect(restoredOcr).toHaveAttribute("data-selected", "true");
  await expect(restoredOcr).toHaveCSS("background-color", "rgb(0, 0, 0)");

  const finalize = page.getByRole("button", {
    name: "保存并生成脱敏文件",
  });
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(
    page.locator('[data-medical-redact-verification="PASS"]'),
  ).toContainText("Verification PASS", { timeout: 60_000 });

  const finalBatch = await newestBatch(request, baseUrl, taskName);
  expect(
    finalBatch.verificationReports.some(
      (report) =>
        report.documentId === imagingDocument.id && report.status === "PASS",
    ),
  ).toBe(true);

  const output = await request.get(
    baseUrl +
      "/api/v1/medical-redact/batches/" +
      finalBatch.id +
      "/documents/" +
      imagingDocument.id +
      "/output",
  );
  expect(output.ok()).toBe(true);
  expect((await output.body()).byteLength).toBeGreaterThan(500);

  expect(fs.existsSync(OUTPATIENT)).toBe(true);
  expect(fs.existsSync(IMAGING)).toBe(true);
});
