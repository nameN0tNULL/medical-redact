package stirling.software.SPDF.medicalredact;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonProperty;

public final class MedicalRedactModels {

    private MedicalRedactModels() {}

    public enum BatchStatus {
        CREATED,
        IMPORTED,
        PROCESSING,
        AUTO_READY,
        IN_REVIEW,
        READY_TO_REDACT,
        REDACTING,
        VERIFYING,
        VERIFIED,
        COMPLETED,
        BLOCKED,
        ERROR,
        CANCELLED
    }

    public enum DocumentStatus {
        IMPORTED,
        PROCESSING,
        IN_REVIEW,
        READY_TO_REDACT,
        REDACTED,
        VERIFIED,
        COMPLETED,
        BLOCKED,
        ERROR
    }

    public enum PageStatus {
        IMPORTED,
        PROCESSING,
        REVIEW_REQUIRED,
        READY,
        ERROR
    }

    public enum SourceKind {
        PDF,
        IMAGE
    }

    public enum TextSource {
        PDF_TEXT,
        PADDLE_OCR,
        LOCAL_REOCR
    }

    public enum TextPageMode {
        PDF_TEXT,
        PADDLE_OCR,
        OCR_UNAVAILABLE
    }

    public enum ReviewTargetType {
        TEXT_REGION,
        MANUAL_RECTANGLE,
        PII_CANDIDATE
    }

    public enum SelectionState {
        UNSELECTED,
        SELECTED
    }

    public enum SelectionSource {
        NONE,
        USER,
        PII_AUTO,
        MANUAL_RECTANGLE
    }

    public enum ReviewActionType {
        SELECT_TEXT,
        DESELECT_TEXT,
        APPROVE,
        REJECT,
        MOVE,
        RESIZE,
        CHANGE_TYPE,
        CHANGE_ROLE,
        ADD_MANUAL,
        DELETE_MANUAL
    }

    public record KnownEntity(String entityType, String value, String entityRole) {}

    public record CreateBatchRequest(String name, List<KnownEntity> knownEntities) {}

    public record SaveReviewActionRequest(
            String documentId,
            ReviewTargetType targetType,
            String targetId,
            ReviewActionType action,
            ReviewActionState before,
            ReviewActionState after) {}

    public record Batch(
            String id,
            String name,
            String sourceType,
            String createdAt,
            BatchStatus status,
            int documentCount,
            int processedCount,
            int reviewRequiredCount,
            int blockedCount,
            String sourceHash,
            List<Document> documents,
            List<ReviewAction> reviewActions,
            List<VerificationReport> verificationReports) {}

    public record Document(
            String id,
            String batchId,
            String originalFilename,
            String sourceRelativePath,
            String fileType,
            String mimeType,
            String sha256,
            long fileSize,
            int pageCount,
            String documentType,
            DocumentStatus status,
            String processingVersion,
            List<Page> pages) {}

    public record Page(
            String id,
            String documentId,
            int pageNo,
            float width,
            float height,
            SourceKind sourceKind,
            int rotation,
            Integer renderDpi,
            PageStatus status) {}

    public record PolygonPoint(float x, float y) {}

    public record CharacterBox(String text, List<PolygonPoint> polygon) {}

    public record TextToken(
            String id,
            String text,
            String pageId,
            List<PolygonPoint> polygon,
            Double confidence,
            String lineId,
            String blockId,
            TextSource source,
            List<CharacterBox> charBoxes) {}

    public record SelectableTextRegion(
            String id,
            String documentId,
            String pageId,
            List<String> tokenIds,
            List<PolygonPoint> polygon,
            TextSource source,
            Double confidence,
            SelectionState selectionState,
            SelectionSource selectionSource) {}

    public record PageTextRegions(
            String pageId,
            int pageNo,
            TextPageMode mode,
            List<TextToken> tokens,
            List<SelectableTextRegion> regions,
            String warningCode,
            long elapsedMs) {}

    public record DocumentTextRegions(
            String documentId,
            List<PageTextRegions> pages,
            boolean engineAvailable,
            boolean piiAvailable,
            List<PiiCandidate> piiCandidates) {}

    public record PiiDetectRequest(
            String documentId,
            List<TextToken> tokens,
            List<KnownEntity> knownEntities,
            List<OcrPageRequest> pageImages) {

        public PiiDetectRequest(
                String documentId, List<TextToken> tokens, List<KnownEntity> knownEntities) {
            this(documentId, tokens, knownEntities, List.of());
        }
    }

    public record AlignmentPolygon(String pageId, List<PolygonPoint> points) {}

    public record CandidateAlignment(
            String level,
            double confidence,
            String method,
            List<AlignmentPolygon> polygons,
            List<String> warnings,
            boolean needsLocalReocr,
            boolean unresolved) {}

    public record PiiCandidate(
            String id,
            String entityType,
            String entityRole,
            int normalizedStart,
            int normalizedEnd,
            int sourceStart,
            int sourceEnd,
            double confidence,
            double overallConfidence,
            String detector,
            List<String> detectorEvidence,
            List<String> pageIds,
            List<String> tokenIds,
            CandidateAlignment alignment,
            String policy,
            String riskStatus,
            boolean conflict) {}

    public record PiiDetectResponse(
            boolean available, List<PiiCandidate> candidates, String warningCode) {}

    public record OcrPageRequest(
            String documentId,
            String pageId,
            int pageNo,
            float pageWidth,
            float pageHeight,
            int renderWidth,
            int renderHeight,
            String imageBase64,
            String mode) {}

    public record OcrPageResponse(
            boolean available,
            String engine,
            String engineVersion,
            List<TextToken> tokens,
            String warningCode,
            long elapsedMs) {}

    public record RedactionCandidate(
            String id,
            String documentId,
            String pageId,
            String entityType,
            float x,
            float y,
            float width,
            float height,
            String source,
            Double confidence,
            String status) {}

    public record RedactionBox(String pageId, float x, float y, float width, float height) {}

    public record ReviewActionState(
            String entityType,
            String entityRole,
            RedactionBox box,
            SelectionState selectionState,
            SelectionSource selectionSource) {}

    public record ReviewAction(
            String id,
            String documentId,
            ReviewTargetType targetType,
            String targetId,
            ReviewActionType action,
            ReviewActionState before,
            ReviewActionState after,
            String operatorId,
            String createdAt) {}

    public record VerificationReport(
            String id,
            String documentId,
            String status,
            int findingCount,
            String createdAt,
            String outputFilename,
            String outputRelativePath,
            String sha256,
            long fileSize,
            int pageCount,
            List<MedicalRedactIssue> issues,
            @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) String message,
            @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) List<String> findingCodes) {

        public VerificationReport(
                String id,
                String documentId,
                String status,
                int findingCount,
                String createdAt,
                String outputFilename,
                String outputRelativePath,
                String sha256,
                long fileSize,
                int pageCount,
                List<MedicalRedactIssue> issues) {
            this(
                    id,
                    documentId,
                    status,
                    findingCount,
                    createdAt,
                    outputFilename,
                    outputRelativePath,
                    sha256,
                    fileSize,
                    pageCount,
                    issues,
                    null,
                    List.of());
        }

        public VerificationReport {
            findingCodes = findingCodes == null ? List.of() : List.copyOf(findingCodes);
            if (issues == null || issues.isEmpty()) {
                issues =
                        "BLOCKED".equals(status)
                                ? MedicalRedactIssueMapper.verificationIssues(findingCodes)
                                : List.of();
            } else {
                issues = List.copyOf(issues);
            }
            if ("PASS".equals(status)
                    && issues.stream().anyMatch(issue -> "BLOCKING".equals(issue.severity()))) {
                throw new IllegalArgumentException(
                        "PASS verification cannot contain blocking issues");
            }
            if ("BLOCKED".equals(status)
                    && issues.stream().noneMatch(issue -> "BLOCKING".equals(issue.severity()))) {
                issues =
                        List.of(
                                MedicalRedactIssueMapper.issue(
                                        MedicalRedactIssueCode.MR_VERIFY_7099, null));
            }
        }
    }

    public record EngineRuntimeCapabilities(
            boolean available,
            String selectedRuntime,
            List<String> availableRuntimes,
            List<String> fallbackChain,
            List<String> onnxProviders,
            String onnxruntimeVersion,
            List<String> modelFormats,
            String warningCode) {

        public EngineRuntimeCapabilities {
            availableRuntimes =
                    availableRuntimes == null ? List.of() : List.copyOf(availableRuntimes);
            fallbackChain = fallbackChain == null ? List.of() : List.copyOf(fallbackChain);
            onnxProviders = onnxProviders == null ? List.of() : List.copyOf(onnxProviders);
            modelFormats = modelFormats == null ? List.of() : List.copyOf(modelFormats);
        }
    }

    public record WorkerSchedule(
            String memoryTier,
            int ocrWorkers,
            int nerWorkers,
            int preprocessWorkers,
            int renderCachePages,
            String ocrModelTier,
            boolean optionalModelsEnabled) {

        public WorkerSchedule {
            if (ocrWorkers < 1 || nerWorkers < 1 || preprocessWorkers < 1 || renderCachePages < 1) {
                throw new IllegalArgumentException("Worker schedule limits must be positive");
            }
        }
    }

    public record RuntimeCapabilities(
            String os,
            String osVersion,
            String arch,
            String cpuModel,
            int physicalCores,
            int logicalCores,
            long totalMemoryBytes,
            boolean appleSilicon,
            boolean nvidiaGpu,
            String nvidiaGpuName,
            Long nvidiaVramBytes,
            List<String> availableRuntimes,
            List<String> detectedAccelerators,
            WorkerSchedule workerSchedule) {

        public RuntimeCapabilities {
            availableRuntimes =
                    availableRuntimes == null ? List.of() : List.copyOf(availableRuntimes);
            detectedAccelerators =
                    detectedAccelerators == null ? List.of() : List.copyOf(detectedAccelerators);
        }
    }

    public record CleanupResult(long deletedFiles) {}
}
