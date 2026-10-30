import apiClient from "@app/services/apiClient";
import { uploadableFile } from "@app/utils/uploadableFile";

export type MedicalRedactBatchStatus =
  | "CREATED"
  | "IMPORTED"
  | "PROCESSING"
  | "AUTO_READY"
  | "IN_REVIEW"
  | "READY_TO_REDACT"
  | "REDACTING"
  | "VERIFYING"
  | "VERIFIED"
  | "COMPLETED"
  | "BLOCKED"
  | "ERROR"
  | "CANCELLED";

export interface MedicalRedactPage {
  id: string;
  documentId: string;
  pageNo: number;
  width: number;
  height: number;
  sourceKind: "PDF" | "IMAGE";
  rotation: number;
  renderDpi: number | null;
  status: string;
}

export type MedicalRedactTextSource = "PDF_TEXT" | "PADDLE_OCR" | "LOCAL_REOCR";

export type MedicalRedactTextPageMode =
  | "PDF_TEXT"
  | "PADDLE_OCR"
  | "OCR_UNAVAILABLE";

export interface MedicalRedactPoint {
  x: number;
  y: number;
}

export interface MedicalRedactCharacterBox {
  text: string;
  polygon: MedicalRedactPoint[];
}

export interface MedicalRedactTextToken {
  id: string;
  text: string;
  pageId: string;
  polygon: MedicalRedactPoint[];
  confidence: number | null;
  lineId: string | null;
  blockId: string | null;
  source: MedicalRedactTextSource;
  charBoxes: MedicalRedactCharacterBox[] | null;
}

export interface MedicalRedactSelectableTextRegion {
  id: string;
  documentId: string;
  pageId: string;
  tokenIds: string[];
  polygon: MedicalRedactPoint[];
  source: MedicalRedactTextSource;
  confidence: number | null;
  selectionState: MedicalRedactSelectionState;
  selectionSource: MedicalRedactSelectionSource;
}

export interface MedicalRedactPageTextRegions {
  pageId: string;
  pageNo: number;
  mode: MedicalRedactTextPageMode;
  tokens: MedicalRedactTextToken[];
  regions: MedicalRedactSelectableTextRegion[];
  warningCode: string | null;
  elapsedMs: number;
}

export interface MedicalRedactKnownEntity {
  entityType: string;
  value: string;
  entityRole?: string | null;
}

export type MedicalRedactCandidatePolicy = "AUTO_SELECT" | "REVIEW" | "KEEP";

export type MedicalRedactCandidateRiskStatus =
  | "RESOLVED"
  | "REVIEW"
  | "CONFLICT"
  | "HIGH_RISK"
  | "UNRESOLVED";

export type MedicalRedactAlignmentLevel = "A" | "B" | "C" | "D";

export interface MedicalRedactAlignmentPolygon {
  pageId: string;
  points: MedicalRedactPoint[];
}

export interface MedicalRedactCandidateAlignment {
  level: MedicalRedactAlignmentLevel;
  confidence: number;
  method: string;
  polygons: MedicalRedactAlignmentPolygon[];
  warnings: string[];
  needsLocalReocr: boolean;
  unresolved: boolean;
}

export interface MedicalRedactPiiCandidate {
  id: string;
  entityType: string;
  entityRole: string | null;
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  confidence: number;
  overallConfidence: number;
  detector: string;
  detectorEvidence: string[];
  pageIds: string[];
  tokenIds: string[];
  alignment: MedicalRedactCandidateAlignment;
  policy: MedicalRedactCandidatePolicy;
  riskStatus: MedicalRedactCandidateRiskStatus;
  conflict: boolean;
}

export interface MedicalRedactDocumentTextRegions {
  documentId: string;
  pages: MedicalRedactPageTextRegions[];
  engineAvailable: boolean;
  piiAvailable: boolean;
  piiCandidates: MedicalRedactPiiCandidate[];
}

export interface MedicalRedactDocument {
  id: string;
  batchId: string;
  originalFilename: string;
  sourceRelativePath: string;
  fileType: string;
  mimeType: string;
  sha256: string;
  fileSize: number;
  pageCount: number;
  documentType: string;
  status: string;
  processingVersion: string;
  pages: MedicalRedactPage[];
}

export interface MedicalRedactWorkerSchedule {
  memoryTier: "LOW" | "CONSTRAINED" | "STANDARD" | "HIGH" | "SAFE_DEFAULT";
  ocrWorkers: number;
  nerWorkers: number;
  preprocessWorkers: number;
  renderCachePages: number;
  ocrModelTier: "TINY" | "SMALL";
  optionalModelsEnabled: boolean;
}

export interface MedicalRedactRuntimeCapabilities {
  os: string;
  osVersion: string;
  arch: string;
  cpuModel: string;
  physicalCores: number;
  logicalCores: number;
  totalMemoryBytes: number;
  appleSilicon: boolean;
  nvidiaGpu: boolean;
  nvidiaGpuName: string | null;
  nvidiaVramBytes: number | null;
  availableRuntimes: string[];
  detectedAccelerators: string[];
  workerSchedule: MedicalRedactWorkerSchedule;
}

export interface MedicalRedactBatch {
  id: string;
  name: string;
  sourceType: string;
  createdAt: string;
  status: MedicalRedactBatchStatus;
  documentCount: number;
  processedCount: number;
  reviewRequiredCount: number;
  blockedCount: number;
  sourceHash: string | null;
  documents: MedicalRedactDocument[];
  reviewActions: MedicalRedactReviewAction[];
  verificationReports: MedicalRedactVerificationReport[];
}

export type MedicalRedactIssueSeverity =
  | "INFO"
  | "WARNING"
  | "ERROR"
  | "BLOCKING";

export interface MedicalRedactIssue {
  code: string;
  severity: MedicalRedactIssueSeverity;
  params?: Record<string, string | number | boolean>;
  documentId?: string | null;
  pageId?: string | null;
  candidateId?: string | null;
  traceId?: string | null;
  legacyCode?: string | null;
}

export interface MedicalRedactVerificationReport {
  id: string;
  documentId: string;
  status: "PASS" | "BLOCKED" | "SKIPPED";
  findingCount: number;
  createdAt: string;
  outputFilename: string | null;
  outputRelativePath: string | null;
  sha256: string | null;
  fileSize: number;
  pageCount: number;
  issues?: MedicalRedactIssue[];
  message?: string;
  findingCodes?: string[];
}

export type MedicalRedactReviewTargetType =
  | "TEXT_REGION"
  | "MANUAL_RECTANGLE"
  | "PII_CANDIDATE";

export type MedicalRedactSelectionState = "UNSELECTED" | "SELECTED";

export type MedicalRedactSelectionSource =
  | "NONE"
  | "USER"
  | "PII_AUTO"
  | "MANUAL_RECTANGLE";

export type MedicalRedactReviewActionType =
  | "SELECT_TEXT"
  | "DESELECT_TEXT"
  | "APPROVE"
  | "REJECT"
  | "MOVE"
  | "RESIZE"
  | "CHANGE_TYPE"
  | "CHANGE_ROLE"
  | "ADD_MANUAL"
  | "DELETE_MANUAL";

export interface MedicalRedactBox {
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MedicalRedactReviewState {
  entityType: string | null;
  entityRole: string | null;
  box: MedicalRedactBox | null;
  selectionState: MedicalRedactSelectionState;
  selectionSource: MedicalRedactSelectionSource;
}

export interface MedicalRedactReviewActionInput {
  documentId: string;
  targetType: MedicalRedactReviewTargetType;
  targetId: string;
  action: MedicalRedactReviewActionType;
  before: MedicalRedactReviewState | null;
  after: MedicalRedactReviewState | null;
}

export interface MedicalRedactReviewAction extends MedicalRedactReviewActionInput {
  id: string;
  operatorId: string;
  createdAt: string;
}

const API_ROOT = "/api/v1/medical-redact";

export async function createMedicalRedactBatch(
  name: string,
  knownEntities: MedicalRedactKnownEntity[] = [],
): Promise<MedicalRedactBatch> {
  const { data } = await apiClient.post<MedicalRedactBatch>(
    `${API_ROOT}/batches`,
    { name, knownEntities },
  );
  return data;
}

export async function listMedicalRedactBatches(): Promise<
  MedicalRedactBatch[]
> {
  const { data } = await apiClient.get<MedicalRedactBatch[]>(
    `${API_ROOT}/batches`,
    { suppressErrorToast: true },
  );
  return data;
}

export async function importMedicalRedactDocuments(
  batchId: string,
  files: File[],
): Promise<MedicalRedactBatch> {
  const form = new FormData();
  files.forEach((file) => form.append("files", uploadableFile(file)));
  const { data } = await apiClient.post<MedicalRedactBatch>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/documents`,
    form,
  );
  return data;
}

export async function downloadMedicalRedactDocument(
  batchId: string,
  document: MedicalRedactDocument,
): Promise<File> {
  const { data } = await apiClient.get<Blob>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/documents/${encodeURIComponent(document.id)}/review`,
    { responseType: "blob" },
  );
  return new File([data], `${document.id}.pdf`, {
    type: "application/pdf",
  });
}

export async function loadMedicalRedactBatchFiles(
  batch: MedicalRedactBatch,
): Promise<File[]> {
  return Promise.all(
    batch.documents.map((document) =>
      downloadMedicalRedactDocument(batch.id, document),
    ),
  );
}

export async function loadMedicalRedactTextRegions(
  batchId: string,
  documentId: string,
): Promise<MedicalRedactDocumentTextRegions> {
  const { data } = await apiClient.get<MedicalRedactDocumentTextRegions>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/documents/${encodeURIComponent(documentId)}/text-regions`,
  );
  return data;
}

export async function finalizeMedicalRedactDocument(
  batchId: string,
  documentId: string,
  verificationEnabled = true,
): Promise<MedicalRedactBatch> {
  const { data } = await apiClient.post<MedicalRedactBatch>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/documents/${encodeURIComponent(documentId)}/finalize?verify=${verificationEnabled}`,
    {},
  );
  return data;
}

export async function downloadMedicalRedactOutput(
  batchId: string,
  documentId: string,
): Promise<Blob> {
  const { data } = await apiClient.get<Blob>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/documents/${encodeURIComponent(documentId)}/output`,
    { responseType: "blob" },
  );
  return data;
}

export async function loadMedicalRedactRuntimeCapabilities(): Promise<MedicalRedactRuntimeCapabilities> {
  const { data } = await apiClient.get<MedicalRedactRuntimeCapabilities>(
    `${API_ROOT}/runtime/capabilities`,
  );
  return data;
}

export async function cleanupMedicalRedactTemp(): Promise<number> {
  const { data } = await apiClient.post<{ deletedFiles: number }>(
    `${API_ROOT}/workspace/cleanup-temp`,
    {},
  );
  return data.deletedFiles;
}

export async function saveMedicalRedactReviewAction(
  batchId: string,
  action: MedicalRedactReviewActionInput,
): Promise<MedicalRedactBatch> {
  const { data } = await apiClient.post<MedicalRedactBatch>(
    `${API_ROOT}/batches/${encodeURIComponent(batchId)}/review-actions`,
    action,
  );
  return data;
}
