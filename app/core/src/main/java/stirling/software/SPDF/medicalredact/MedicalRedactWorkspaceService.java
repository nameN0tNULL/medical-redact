package stirling.software.SPDF.medicalredact;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;

import javax.imageio.ImageIO;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.Batch;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.BatchStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CleanupResult;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Document;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.KnownEntity;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Page;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PageStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiCandidate;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RedactionBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewAction;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewTargetType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SaveReviewActionRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectableTextRegion;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SourceKind;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.VerificationReport;
import stirling.software.common.configuration.InstallationPathConfig;

import tools.jackson.databind.ObjectMapper;

@Service
public class MedicalRedactWorkspaceService {

    @FunctionalInterface
    public interface OutputSemanticVerifier {
        List<MedicalRedactIssue> verify(Document document, Path outputPath) throws IOException;
    }

    private static final Set<String> SUPPORTED_TYPES =
            Set.of("pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp");
    private static final Set<String> KNOWN_ENTITY_TYPES =
            Set.of(
                    "PATIENT_NAME",
                    "CN_ID_CARD",
                    "PHONE",
                    "MEDICAL_RECORD_NO",
                    "INPATIENT_NO",
                    "OUTPATIENT_NO",
                    "INSURANCE_NO",
                    "PATIENT_ID");
    private static final DateTimeFormatter DEFAULT_NAME_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault());
    private static final float REDACTION_PADDING_POINTS = 2.0f;

    private final ObjectMapper objectMapper;
    private final Path workspaceRoot;
    private final Path sourceRoot;
    private final Path pagesRoot;
    private final Path cacheRoot;
    private final Path batchesRoot;
    private final Path tempRoot;
    private final Path outputRoot;
    private final Path reportsRoot;

    @Autowired
    public MedicalRedactWorkspaceService(ObjectMapper objectMapper) throws IOException {
        this(objectMapper, defaultWorkspaceRoot());
    }

    MedicalRedactWorkspaceService(ObjectMapper objectMapper, Path workspaceRoot)
            throws IOException {
        this.objectMapper = objectMapper;
        this.workspaceRoot = workspaceRoot.toAbsolutePath().normalize();
        this.sourceRoot = this.workspaceRoot.resolve("source");
        this.pagesRoot = this.workspaceRoot.resolve("pages");
        this.cacheRoot = this.workspaceRoot.resolve("cache");
        this.batchesRoot = this.workspaceRoot.resolve("db").resolve("batches");
        this.tempRoot = this.workspaceRoot.resolve("temp");
        this.outputRoot = this.workspaceRoot.resolve("output");
        this.reportsRoot = this.workspaceRoot.resolve("reports");
        initializeWorkspace();
    }

    private static Path defaultWorkspaceRoot() {
        String override = System.getProperty("medical-redact.workspace-path");
        if (override == null || override.isBlank()) {
            override = System.getenv("MEDICAL_REDACT_WORKSPACE_PATH");
        }
        if (override != null && !override.isBlank()) {
            return Path.of(override);
        }
        return Path.of(InstallationPathConfig.getPath(), "medical-redact", "workspace");
    }

    private void initializeWorkspace() throws IOException {
        Files.createDirectories(sourceRoot);
        Files.createDirectories(pagesRoot);
        Files.createDirectories(cacheRoot);
        Files.createDirectories(batchesRoot);
        Files.createDirectories(tempRoot);
        Files.createDirectories(outputRoot);
        Files.createDirectories(reportsRoot);
    }

    public synchronized Batch createBatch(String requestedName) throws IOException {
        return createBatch(requestedName, List.of());
    }

    public synchronized Batch createBatch(String requestedName, List<KnownEntity> knownEntities)
            throws IOException {
        String batchId = UUID.randomUUID().toString();
        String name = normalizeBatchName(requestedName);
        List<KnownEntity> normalizedKnownEntities = normalizeKnownEntities(knownEntities);
        Batch batch =
                new Batch(
                        batchId,
                        name,
                        "FILES",
                        Instant.now().toString(),
                        BatchStatus.CREATED,
                        0,
                        0,
                        0,
                        0,
                        null,
                        List.of(),
                        List.of(),
                        List.of());

        createBatchDirectories(batchId);
        persistBatch(batch);
        persistKnownEntityContext(batchId, normalizedKnownEntities);
        return batch;
    }

    public synchronized List<KnownEntity> getKnownEntities(String batchId) throws IOException {
        String validatedBatchId = validateBatchId(batchId);
        getBatch(validatedBatchId);
        Path file = knownEntityContextFile(validatedBatchId);
        if (!Files.isRegularFile(file)) {
            return List.of();
        }
        KnownEntityContext context =
                objectMapper.readValue(file.toFile(), KnownEntityContext.class);
        return context.entities() == null ? List.of() : List.copyOf(context.entities());
    }

    public synchronized List<Batch> listBatches() throws IOException {
        if (!Files.exists(batchesRoot)) {
            return List.of();
        }
        try (var files = Files.list(batchesRoot)) {
            List<Batch> batches = new ArrayList<>();
            for (Path file :
                    files.filter(path -> path.getFileName().toString().endsWith(".json"))
                            .toList()) {
                batches.add(readBatchFile(file));
            }
            batches.sort(Comparator.comparing(Batch::createdAt).reversed());
            return List.copyOf(batches);
        }
    }

    public synchronized Batch getBatch(String batchId) throws IOException {
        return readBatchFile(batchFile(validateBatchId(batchId)));
    }

    public synchronized Batch importDocuments(String batchId, List<MultipartFile> files)
            throws IOException {
        String validatedBatchId = validateBatchId(batchId);
        Batch current = getBatch(validatedBatchId);
        if (files == null || files.isEmpty()) {
            throw new IllegalArgumentException("At least one PDF or image is required");
        }

        Path batchTemp = tempRoot.resolve(validatedBatchId);
        Path batchSource = sourceRoot.resolve(validatedBatchId);
        Files.createDirectories(batchTemp);
        Files.createDirectories(batchSource);

        List<StagedDocument> staged = new ArrayList<>();
        List<Path> committed = new ArrayList<>();
        try {
            for (MultipartFile file : files) {
                staged.add(stageDocument(validatedBatchId, file, batchTemp));
            }

            for (StagedDocument item : staged) {
                Path target =
                        batchSource.resolve(
                                item.document().id() + "." + item.document().fileType());
                moveAtomically(item.stagedPath(), target);
                markReadOnly(target);
                committed.add(target);
            }

            List<Document> documents = new ArrayList<>(current.documents());
            for (StagedDocument item : staged) {
                Path target =
                        batchSource.resolve(
                                item.document().id() + "." + item.document().fileType());
                String relativePath = toWorkspaceRelativePath(target);
                Document document = item.document();
                documents.add(
                        new Document(
                                document.id(),
                                document.batchId(),
                                document.originalFilename(),
                                relativePath,
                                document.fileType(),
                                document.mimeType(),
                                document.sha256(),
                                document.fileSize(),
                                document.pageCount(),
                                document.documentType(),
                                document.status(),
                                document.processingVersion(),
                                document.pages()));
            }

            Batch updated =
                    new Batch(
                            current.id(),
                            current.name(),
                            current.sourceType(),
                            current.createdAt(),
                            BatchStatus.IMPORTED,
                            documents.size(),
                            current.processedCount(),
                            current.reviewRequiredCount(),
                            current.blockedCount(),
                            aggregateSourceHash(documents),
                            List.copyOf(documents),
                            current.reviewActions(),
                            current.verificationReports());
            persistBatch(updated);
            return updated;
        } catch (IOException | RuntimeException e) {
            for (Path path : committed) {
                makeWritable(path);
                Files.deleteIfExists(path);
            }
            throw e;
        } finally {
            for (StagedDocument item : staged) {
                Files.deleteIfExists(item.stagedPath());
            }
            deleteDirectoryIfEmpty(batchTemp);
        }
    }

    public synchronized SourceFile openSource(String batchId, String documentId)
            throws IOException {
        Batch batch = getBatch(batchId);
        Document document =
                batch.documents().stream()
                        .filter(item -> item.id().equals(documentId))
                        .findFirst()
                        .orElseThrow(() -> new NoSuchElementException("Document not found"));

        Path path = workspaceRoot.resolve(document.sourceRelativePath()).normalize();
        if (!path.startsWith(sourceRoot) || !Files.isRegularFile(path)) {
            throw new NoSuchElementException("Document source is unavailable");
        }
        return new SourceFile(document, path);
    }

    public synchronized SourceFile openReviewPdf(String batchId, String documentId)
            throws IOException {
        SourceFile source = openSource(batchId, documentId);
        if ("pdf".equals(source.document().fileType())) {
            return source;
        }

        Path reviewPath =
                pagesRoot
                        .resolve(validateBatchId(batchId))
                        .resolve(source.document().id() + ".pdf");
        if (!Files.isRegularFile(reviewPath)) {
            BufferedImage image = ImageIO.read(source.path().toFile());
            if (image == null) {
                throw new IllegalArgumentException("The image file could not be decoded");
            }
            Path temp = reviewPath.resolveSibling(reviewPath.getFileName() + ".tmp");
            try (PDDocument review = new PDDocument()) {
                Page pageModel = source.document().pages().getFirst();
                PDPage page = new PDPage(new PDRectangle(pageModel.width(), pageModel.height()));
                review.addPage(page);
                PDImageXObject imageObject = LosslessFactory.createFromImage(review, image);
                try (PDPageContentStream content = new PDPageContentStream(review, page)) {
                    content.drawImage(imageObject, 0, 0, pageModel.width(), pageModel.height());
                }
                review.save(temp.toFile());
            }
            moveAtomically(temp, reviewPath);
            markReadOnly(reviewPath);
        }
        return new SourceFile(source.document(), reviewPath);
    }

    public synchronized Batch finalizeDocument(String batchId, String documentId)
            throws IOException {
        return finalizeDocument(batchId, documentId, null, null);
    }

    public synchronized Batch finalizeDocument(
            String batchId, String documentId, DocumentTextRegions textRegions) throws IOException {
        return finalizeDocument(batchId, documentId, textRegions, null);
    }

    public synchronized Batch finalizeDocument(
            String batchId,
            String documentId,
            DocumentTextRegions textRegions,
            OutputSemanticVerifier semanticVerifier)
            throws IOException {
        return finalizeDocument(batchId, documentId, textRegions, semanticVerifier, true);
    }

    public synchronized Batch finalizeDocument(
            String batchId,
            String documentId,
            DocumentTextRegions textRegions,
            OutputSemanticVerifier semanticVerifier,
            boolean verificationEnabled)
            throws IOException {
        Batch current = getBatch(batchId);
        Document document =
                current.documents().stream()
                        .filter(item -> item.id().equals(documentId))
                        .findFirst()
                        .orElseThrow(() -> new NoSuchElementException("Document not found"));
        List<ReviewActionState> states = materializeReviewStates(current, document);
        List<PiiCandidate> blockingRisks =
                !verificationEnabled || textRegions == null
                        ? List.of()
                        : unresolvedPiiRisks(current, document, textRegions);
        if (!blockingRisks.isEmpty()) {
            List<MedicalRedactIssue> issues =
                    blockingRisks.stream()
                            .map(candidate -> unresolvedRiskIssue(document, candidate, textRegions))
                            .toList();
            VerificationReport report =
                    new VerificationReport(
                            UUID.randomUUID().toString(),
                            document.id(),
                            "BLOCKED",
                            issues.size(),
                            Instant.now().toString(),
                            null,
                            null,
                            null,
                            0,
                            document.pageCount(),
                            issues);
            return persistVerification(current, document, report, DocumentStatus.BLOCKED);
        }
        if (states.isEmpty()) {
            VerificationReport report =
                    new VerificationReport(
                            UUID.randomUUID().toString(),
                            document.id(),
                            "BLOCKED",
                            1,
                            Instant.now().toString(),
                            null,
                            null,
                            null,
                            0,
                            document.pageCount(),
                            List.of(
                                    MedicalRedactIssueMapper.issue(
                                            MedicalRedactIssueCode.MR_VERIFY_7001,
                                            "NO_SELECTED_REDACTION")));
            return persistVerification(current, document, report, DocumentStatus.BLOCKED);
        }

        String reportId = UUID.randomUUID().toString();
        String compactDocumentId = document.id().replace("-", "");
        String outputFilename =
                "DOC"
                        + compactDocumentId
                                .substring(0, Math.min(12, compactDocumentId.length()))
                                .toUpperCase(Locale.ROOT)
                        + "-"
                        + reportId.substring(0, 8).toUpperCase(Locale.ROOT)
                        + ".pdf";
        Path outputPath = outputRoot.resolve(validateBatchId(batchId)).resolve(outputFilename);
        Path temporaryPath = tempRoot.resolve(validateBatchId(batchId)).resolve(reportId + ".pdf");
        Files.createDirectories(temporaryPath.getParent());
        Files.createDirectories(outputPath.getParent());

        try {
            SourceFile source = openSource(batchId, documentId);
            renderSecureRasterOutput(document, source.path(), states, temporaryPath);
            List<MedicalRedactIssue> issues = new ArrayList<>();
            if (verificationEnabled) {
                try {
                    List<String> structuralFindings =
                            verifySecureRasterOutput(document, temporaryPath, states);
                    if (!structuralFindings.isEmpty()) {
                        issues.addAll(
                                MedicalRedactIssueMapper.verificationIssues(structuralFindings));
                    }
                } catch (IOException | RuntimeException e) {
                    issues.add(
                            MedicalRedactIssueMapper.issue(
                                    MedicalRedactIssueCode.MR_VERIFY_7003,
                                    "VERIFICATION_OUTPUT_READ_FAILED"));
                }
                if (semanticVerifier != null) {
                    try {
                        List<MedicalRedactIssue> semanticFindings =
                                semanticVerifier.verify(document, temporaryPath);
                        if (semanticFindings != null) {
                            issues.addAll(semanticFindings);
                        }
                    } catch (IOException | RuntimeException e) {
                        issues.add(
                                MedicalRedactIssueMapper.issue(
                                        MedicalRedactIssueCode.MR_VERIFY_7014,
                                        "SEMANTIC_VERIFICATION_FAILED"));
                    }
                }
            }
            if (!issues.isEmpty()) {
                Files.deleteIfExists(temporaryPath);
                VerificationReport report =
                        new VerificationReport(
                                reportId,
                                document.id(),
                                "BLOCKED",
                                issues.size(),
                                Instant.now().toString(),
                                null,
                                null,
                                null,
                                0,
                                document.pageCount(),
                                issues);
                return persistVerification(current, document, report, DocumentStatus.BLOCKED);
            }

            moveAtomically(temporaryPath, outputPath);
            markReadOnly(outputPath);
            VerificationReport report =
                    new VerificationReport(
                            reportId,
                            document.id(),
                            verificationEnabled ? "PASS" : "SKIPPED",
                            0,
                            Instant.now().toString(),
                            outputFilename,
                            toWorkspaceRelativePath(outputPath),
                            sha256(outputPath),
                            Files.size(outputPath),
                            document.pageCount(),
                            List.of());
            return persistVerification(current, document, report, DocumentStatus.VERIFIED);
        } finally {
            Files.deleteIfExists(temporaryPath);
        }
    }

    public synchronized OutputFile openOutput(String batchId, String documentId)
            throws IOException {
        Batch batch = getBatch(batchId);
        Document document =
                batch.documents().stream()
                        .filter(item -> item.id().equals(documentId))
                        .findFirst()
                        .orElseThrow(() -> new NoSuchElementException("Document not found"));
        VerificationReport report = null;
        for (int index = batch.verificationReports().size() - 1; index >= 0; index--) {
            VerificationReport candidate = batch.verificationReports().get(index);
            if (document.id().equals(candidate.documentId())
                    && ("PASS".equals(candidate.status()) || "SKIPPED".equals(candidate.status()))
                    && candidate.outputRelativePath() != null) {
                report = candidate;
                break;
            }
        }
        if (report == null) {
            throw new IllegalStateException("Generated output is not available");
        }
        Path path = workspaceRoot.resolve(report.outputRelativePath()).normalize();
        if (!path.startsWith(outputRoot) || !Files.isRegularFile(path)) {
            throw new NoSuchElementException("Generated output is unavailable");
        }
        return new OutputFile(document, report, path);
    }

    public synchronized Batch saveReviewAction(String batchId, SaveReviewActionRequest request)
            throws IOException {
        Batch current = getBatch(batchId);
        if (request == null) {
            throw new IllegalArgumentException("Review action is required");
        }
        if (request.documentId() == null || request.documentId().isBlank()) {
            throw new IllegalArgumentException("Document id is required");
        }
        Document document =
                current.documents().stream()
                        .filter(item -> item.id().equals(request.documentId()))
                        .findFirst()
                        .orElseThrow(() -> new NoSuchElementException("Document not found"));
        validateReviewAction(document, request);

        ReviewAction action =
                new ReviewAction(
                        UUID.randomUUID().toString(),
                        document.id(),
                        request.targetType(),
                        request.targetId(),
                        request.action(),
                        request.before(),
                        request.after(),
                        "local-user",
                        Instant.now().toString());
        List<ReviewAction> reviewActions = new ArrayList<>(current.reviewActions());
        reviewActions.add(action);

        List<Document> documents =
                current.documents().stream()
                        .map(
                                item ->
                                        item.id().equals(document.id())
                                                ? withStatus(item, DocumentStatus.IN_REVIEW)
                                                : item)
                        .toList();
        Batch updated =
                new Batch(
                        current.id(),
                        current.name(),
                        current.sourceType(),
                        current.createdAt(),
                        BatchStatus.IN_REVIEW,
                        current.documentCount(),
                        current.processedCount(),
                        current.reviewRequiredCount(),
                        current.blockedCount(),
                        current.sourceHash(),
                        documents,
                        List.copyOf(reviewActions),
                        current.verificationReports().stream()
                                .filter(report -> !document.id().equals(report.documentId()))
                                .toList());
        persistBatch(updated);
        return updated;
    }

    private List<ReviewActionState> materializeReviewStates(Batch batch, Document document) {
        Map<String, ReviewActionState> states = materializeReviewStateMap(batch, document);
        return states.entrySet().stream()
                .filter(
                        entry ->
                                entry.getKey().startsWith(ReviewTargetType.TEXT_REGION.name() + ":")
                                        || entry.getKey()
                                                .startsWith(
                                                        ReviewTargetType.MANUAL_RECTANGLE.name()
                                                                + ":"))
                .map(Map.Entry::getValue)
                .toList();
    }

    private Map<String, ReviewActionState> materializeReviewStateMap(
            Batch batch, Document document) {
        Map<String, ReviewActionState> latest = new LinkedHashMap<>();
        for (ReviewAction action : batch.reviewActions()) {
            if (!document.id().equals(action.documentId())) {
                continue;
            }
            String key = action.targetType().name() + ":" + action.targetId();
            ReviewActionState after = action.after();
            if (action.action() == ReviewActionType.DELETE_MANUAL
                    || action.action() == ReviewActionType.DESELECT_TEXT
                    || action.action() == ReviewActionType.REJECT
                    || after == null
                    || after.box() == null
                    || after.selectionState() != SelectionState.SELECTED) {
                latest.remove(key);
                continue;
            }
            latest.put(key, after);
        }
        return latest;
    }

    private List<PiiCandidate> unresolvedPiiRisks(
            Batch batch, Document document, DocumentTextRegions textRegions) {
        if (!document.id().equals(textRegions.documentId())
                || textRegions.piiCandidates() == null
                || textRegions.piiCandidates().isEmpty()) {
            return List.of();
        }
        Map<String, ReviewActionState> reviewStates = materializeReviewStateMap(batch, document);
        return textRegions.piiCandidates().stream()
                .filter(this::isBlockingRisk)
                .filter(
                        candidate ->
                                !isExplicitlyRejected(batch, document, candidate)
                                        && !isCandidateCovered(
                                                candidate, textRegions, reviewStates))
                .toList();
    }

    private MedicalRedactIssue unresolvedRiskIssue(
            Document document, PiiCandidate candidate, DocumentTextRegions textRegions) {
        RedactionBox box = firstCandidateRiskBox(candidate, textRegions);
        String pageId =
                box != null
                        ? box.pageId()
                        : candidate.pageIds() == null || candidate.pageIds().isEmpty()
                                ? null
                                : candidate.pageIds().getFirst();
        Integer pageNo =
                pageId == null
                        ? null
                        : document.pages().stream()
                                .filter(page -> page.id().equals(pageId))
                                .map(Page::pageNo)
                                .findFirst()
                                .orElse(null);
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("entityType", candidate.entityType());
        params.put("riskStatus", candidate.riskStatus());
        if (pageNo != null) {
            params.put("pageNo", pageNo);
        }
        if (box != null) {
            params.put("x", box.x());
            params.put("y", box.y());
            params.put("width", box.width());
            params.put("height", box.height());
        }
        return new MedicalRedactIssue(
                MedicalRedactIssueCode.MR_VERIFY_7002.code(),
                MedicalRedactIssueCode.MR_VERIFY_7002.severity(),
                params,
                document.id(),
                pageId,
                candidate.id(),
                null,
                "UNRESOLVED_PII_RISK");
    }

    private RedactionBox firstCandidateRiskBox(
            PiiCandidate candidate, DocumentTextRegions textRegions) {
        if (candidate.alignment() != null
                && candidate.alignment().polygons() != null
                && !candidate.alignment().polygons().isEmpty()) {
            for (var polygon : candidate.alignment().polygons()) {
                RedactionBox box =
                        polygon.points() == null
                                ? null
                                : polygonBox(polygon.pageId(), polygon.points());
                if (box != null) {
                    return box;
                }
            }
        }

        Set<String> tokenIds =
                candidate.tokenIds() == null ? Set.of() : Set.copyOf(candidate.tokenIds());
        return textRegions.pages().stream()
                .flatMap(page -> page.regions().stream())
                .filter(region -> region.tokenIds().stream().anyMatch(tokenIds::contains))
                .map(this::regionBox)
                .filter(box -> box != null)
                .findFirst()
                .orElse(null);
    }

    private boolean isBlockingRisk(PiiCandidate candidate) {
        return candidate != null
                && ("UNRESOLVED".equals(candidate.riskStatus())
                        || "HIGH_RISK".equals(candidate.riskStatus())
                        || "CONFLICT".equals(candidate.riskStatus()));
    }

    private boolean isExplicitlyRejected(Batch batch, Document document, PiiCandidate candidate) {
        for (int index = batch.reviewActions().size() - 1; index >= 0; index--) {
            ReviewAction action = batch.reviewActions().get(index);
            if (!document.id().equals(action.documentId())
                    || action.targetType() != ReviewTargetType.PII_CANDIDATE
                    || !candidate.id().equals(action.targetId())) {
                continue;
            }
            return action.action() == ReviewActionType.REJECT;
        }
        return false;
    }

    private boolean isCandidateCovered(
            PiiCandidate candidate,
            DocumentTextRegions textRegions,
            Map<String, ReviewActionState> reviewStates) {
        Set<String> candidateTokenIds =
                candidate.tokenIds() == null ? Set.of() : Set.copyOf(candidate.tokenIds());
        List<SelectableTextRegion> candidateRegions =
                textRegions.pages().stream()
                        .flatMap(page -> page.regions().stream())
                        .filter(
                                region ->
                                        region.tokenIds().stream()
                                                .anyMatch(candidateTokenIds::contains))
                        .toList();

        boolean selectedText =
                candidateRegions.stream()
                        .anyMatch(
                                region ->
                                        isSelected(
                                                reviewStates.get(
                                                        ReviewTargetType.TEXT_REGION.name()
                                                                + ":"
                                                                + region.id())));
        if (selectedText) {
            return true;
        }

        List<RedactionBox> riskBoxes = candidateRegions.stream().map(this::regionBox).toList();
        if (candidate.alignment() != null
                && candidate.alignment().polygons() != null
                && !candidate.alignment().polygons().isEmpty()) {
            riskBoxes =
                    candidate.alignment().polygons().stream()
                            .map(
                                    polygon ->
                                            polygon.points() == null
                                                    ? null
                                                    : polygonBox(
                                                            polygon.pageId(), polygon.points()))
                            .filter(box -> box != null)
                            .toList();
        }
        if (riskBoxes.isEmpty()) {
            return false;
        }

        for (Map.Entry<String, ReviewActionState> entry : reviewStates.entrySet()) {
            if (!entry.getKey().startsWith(ReviewTargetType.MANUAL_RECTANGLE.name() + ":")
                    || !isSelected(entry.getValue())
                    || entry.getValue().box() == null) {
                continue;
            }
            RedactionBox manual = entry.getValue().box();
            if (riskBoxes.stream().anyMatch(risk -> covers(manual, risk))) {
                return true;
            }
        }
        return false;
    }

    private boolean isSelected(ReviewActionState state) {
        return state != null
                && state.selectionState() == SelectionState.SELECTED
                && state.box() != null;
    }

    private RedactionBox regionBox(SelectableTextRegion region) {
        return polygonBox(region.pageId(), region.polygon());
    }

    private RedactionBox polygonBox(String pageId, List<MedicalRedactModels.PolygonPoint> points) {
        if (points == null || points.size() < 4) {
            return null;
        }
        float left = Float.MAX_VALUE;
        float top = Float.MAX_VALUE;
        float right = -Float.MAX_VALUE;
        float bottom = -Float.MAX_VALUE;
        for (MedicalRedactModels.PolygonPoint point : points) {
            if (point == null || !Float.isFinite(point.x()) || !Float.isFinite(point.y())) {
                return null;
            }
            left = Math.min(left, point.x());
            top = Math.min(top, point.y());
            right = Math.max(right, point.x());
            bottom = Math.max(bottom, point.y());
        }
        if (right <= left || bottom <= top) {
            return null;
        }
        return new RedactionBox(pageId, left, top, right - left, bottom - top);
    }

    private boolean covers(RedactionBox selected, RedactionBox risk) {
        if (!selected.pageId().equals(risk.pageId())) {
            return false;
        }
        float left = Math.max(selected.x(), risk.x());
        float top = Math.max(selected.y(), risk.y());
        float right = Math.min(selected.x() + selected.width(), risk.x() + risk.width());
        float bottom = Math.min(selected.y() + selected.height(), risk.y() + risk.height());
        if (right <= left || bottom <= top) {
            return false;
        }
        double intersection = (right - left) * (double) (bottom - top);
        double riskArea = risk.width() * (double) risk.height();
        return riskArea > 0 && intersection / riskArea >= 0.8;
    }

    private Batch persistVerification(
            Batch current,
            Document document,
            VerificationReport report,
            DocumentStatus documentStatus)
            throws IOException {
        List<Document> documents =
                current.documents().stream()
                        .map(
                                item ->
                                        item.id().equals(document.id())
                                                ? withStatus(item, documentStatus)
                                                : item)
                        .toList();
        List<VerificationReport> reports = new ArrayList<>(current.verificationReports());
        reports.add(report);

        int verifiedCount =
                (int)
                        documents.stream()
                                .filter(item -> item.status() == DocumentStatus.VERIFIED)
                                .count();
        int blockedCount =
                (int)
                        documents.stream()
                                .filter(item -> item.status() == DocumentStatus.BLOCKED)
                                .count();
        int reviewRequiredCount =
                (int)
                        documents.stream()
                                .filter(
                                        item ->
                                                item.status() == DocumentStatus.IMPORTED
                                                        || item.status() == DocumentStatus.IN_REVIEW
                                                        || item.status()
                                                                == DocumentStatus.READY_TO_REDACT)
                                .count();
        BatchStatus status;
        if (blockedCount > 0) {
            status = BatchStatus.BLOCKED;
        } else if (!documents.isEmpty() && verifiedCount == documents.size()) {
            status = BatchStatus.VERIFIED;
        } else {
            status = BatchStatus.IN_REVIEW;
        }

        Batch updated =
                new Batch(
                        current.id(),
                        current.name(),
                        current.sourceType(),
                        current.createdAt(),
                        status,
                        current.documentCount(),
                        verifiedCount,
                        reviewRequiredCount,
                        blockedCount,
                        current.sourceHash(),
                        documents,
                        current.reviewActions(),
                        List.copyOf(reports));
        persistBatch(updated);

        Path reportPath =
                reportsRoot
                        .resolve(validateBatchId(current.id()))
                        .resolve(report.documentId() + "-" + report.id() + ".json");
        Files.createDirectories(reportPath.getParent());
        objectMapper.writerWithDefaultPrettyPrinter().writeValue(reportPath.toFile(), report);
        return updated;
    }

    private void renderSecureRasterOutput(
            Document document, Path sourcePath, List<ReviewActionState> states, Path target)
            throws IOException {
        if ("pdf".equals(document.fileType())) {
            try (PDDocument source = Loader.loadPDF(sourcePath.toFile());
                    PDDocument output = new PDDocument()) {
                PDFRenderer renderer = new PDFRenderer(source);
                for (int index = 0; index < source.getNumberOfPages(); index++) {
                    Page page = document.pages().get(index);
                    BufferedImage image = renderer.renderImageWithDPI(index, 144, ImageType.RGB);
                    applyReviewBoxes(image, page, states);
                    appendRasterPage(output, image, page.width(), page.height());
                }
                resetOutputMetadata(output);
                output.save(target.toFile());
            }
            return;
        }

        BufferedImage image = ImageIO.read(sourcePath.toFile());
        if (image == null) {
            throw new IllegalArgumentException("The image file could not be decoded");
        }
        try (PDDocument output = new PDDocument()) {
            Page page = document.pages().getFirst();
            applyReviewBoxes(image, page, states);
            appendRasterPage(output, image, page.width(), page.height());
            resetOutputMetadata(output);
            output.save(target.toFile());
        }
    }

    private void appendRasterPage(
            PDDocument output, BufferedImage image, float pageWidth, float pageHeight)
            throws IOException {
        PDPage page = new PDPage(new PDRectangle(pageWidth, pageHeight));
        output.addPage(page);
        PDImageXObject imageObject = LosslessFactory.createFromImage(output, image);
        try (PDPageContentStream content = new PDPageContentStream(output, page)) {
            content.drawImage(imageObject, 0, 0, pageWidth, pageHeight);
        }
    }

    private void applyReviewBoxes(BufferedImage image, Page page, List<ReviewActionState> states) {
        double scaleX = image.getWidth() / (double) page.width();
        double scaleY = image.getHeight() / (double) page.height();
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(
                    RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_OFF);
            graphics.setColor(Color.BLACK);
            for (ReviewActionState state : states) {
                RedactionBox box = state.box();
                if (box == null || !page.id().equals(box.pageId())) {
                    continue;
                }
                RedactionBox paddedBox = expandRedactionBox(box, page);
                int x = Math.max(0, (int) Math.floor(paddedBox.x() * scaleX));
                int y = Math.max(0, (int) Math.floor(paddedBox.y() * scaleY));
                int maxX =
                        Math.min(
                                image.getWidth(),
                                (int) Math.ceil((paddedBox.x() + paddedBox.width()) * scaleX));
                int maxY =
                        Math.min(
                                image.getHeight(),
                                (int) Math.ceil((paddedBox.y() + paddedBox.height()) * scaleY));
                graphics.fillRect(x, y, Math.max(1, maxX - x), Math.max(1, maxY - y));
            }
        } finally {
            graphics.dispose();
        }
    }

    private List<String> verifySecureRasterOutput(
            Document document, Path outputPath, List<ReviewActionState> states) throws IOException {
        Set<String> findings = new LinkedHashSet<>();
        try (PDDocument output = Loader.loadPDF(outputPath.toFile())) {
            if (output.getNumberOfPages() != document.pageCount()) {
                findings.add("PAGE_COUNT_MISMATCH");
            }
            if (!new PDFTextStripper().getText(output).trim().isEmpty()) {
                findings.add("TEXT_LAYER_SURVIVED");
            }
            if (output.getDocumentCatalog().getMetadata() != null
                    || output.getDocumentCatalog().getNames() != null
                    || output.getDocumentCatalog().getAcroForm() != null
                    || output.getDocumentCatalog().getOCProperties() != null) {
                findings.add("PDF_STRUCTURE_SURVIVED");
            }
            if (!output.getDocumentInformation().getMetadataKeys().isEmpty()) {
                findings.add("METADATA_SURVIVED");
            }
            for (PDPage page : output.getPages()) {
                if (!page.getAnnotations().isEmpty()) {
                    findings.add("ANNOTATION_SURVIVED");
                    break;
                }
            }

            PDFRenderer renderer = new PDFRenderer(output);
            for (int index = 0;
                    index < Math.min(output.getNumberOfPages(), document.pages().size());
                    index++) {
                Page page = document.pages().get(index);
                BufferedImage rendered = renderer.renderImageWithDPI(index, 72, ImageType.RGB);
                for (ReviewActionState state : states) {
                    RedactionBox box = state.box();
                    if (box != null
                            && page.id().equals(box.pageId())
                            && !isVerifiedBlackBox(rendered, page, box)) {
                        findings.add("REDACTION_BOX_NOT_BLACK");
                    }
                }
            }
        }
        return List.copyOf(findings);
    }

    private boolean isVerifiedBlackBox(BufferedImage image, Page page, RedactionBox box) {
        RedactionBox paddedBox = expandRedactionBox(box, page);
        double scaleX = image.getWidth() / (double) page.width();
        double scaleY = image.getHeight() / (double) page.height();
        int x1 = Math.max(0, (int) Math.ceil(paddedBox.x() * scaleX) + 1);
        int y1 = Math.max(0, (int) Math.ceil(paddedBox.y() * scaleY) + 1);
        int x2 =
                Math.min(
                        image.getWidth(),
                        (int) Math.floor((paddedBox.x() + paddedBox.width()) * scaleX) - 1);
        int y2 =
                Math.min(
                        image.getHeight(),
                        (int) Math.floor((paddedBox.y() + paddedBox.height()) * scaleY) - 1);
        if (x2 <= x1 || y2 <= y1) {
            return false;
        }

        long dark = 0;
        long total = 0;
        int stepX = Math.max(1, (x2 - x1) / 80);
        int stepY = Math.max(1, (y2 - y1) / 80);
        for (int y = y1; y < y2; y += stepY) {
            for (int x = x1; x < x2; x += stepX) {
                int rgb = image.getRGB(x, y);
                int red = (rgb >> 16) & 0xff;
                int green = (rgb >> 8) & 0xff;
                int blue = rgb & 0xff;
                if (red < 32 && green < 32 && blue < 32) {
                    dark++;
                }
                total++;
            }
        }
        return total > 0 && dark >= Math.ceil(total * 0.98);
    }

    private RedactionBox expandRedactionBox(RedactionBox box, Page page) {
        float left = Math.max(0, box.x() - REDACTION_PADDING_POINTS);
        float top = Math.max(0, box.y() - REDACTION_PADDING_POINTS);
        float right = Math.min(page.width(), box.x() + box.width() + REDACTION_PADDING_POINTS);
        float bottom = Math.min(page.height(), box.y() + box.height() + REDACTION_PADDING_POINTS);
        return new RedactionBox(box.pageId(), left, top, right - left, bottom - top);
    }

    private void resetOutputMetadata(PDDocument output) {
        output.setDocumentInformation(new PDDocumentInformation());
        output.getDocumentCatalog().setMetadata(null);
    }

    Path internalWorkspaceRoot() {
        return workspaceRoot;
    }

    public synchronized CleanupResult cleanupTemp() throws IOException {
        if (!Files.exists(tempRoot)) {
            Files.createDirectories(tempRoot);
            return new CleanupResult(0);
        }

        long deletedFiles;
        try (var paths = Files.walk(tempRoot)) {
            deletedFiles = paths.filter(Files::isRegularFile).count();
        }

        try (var paths = Files.walk(tempRoot)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                if (!path.equals(tempRoot)) {
                    makeWritable(path);
                    Files.deleteIfExists(path);
                }
            }
        }
        Files.createDirectories(tempRoot);
        return new CleanupResult(deletedFiles);
    }

    private StagedDocument stageDocument(String batchId, MultipartFile file, Path batchTemp)
            throws IOException {
        String originalFilename = safeOriginalFilename(file.getOriginalFilename());
        String fileType = extensionOf(originalFilename);
        if (!SUPPORTED_TYPES.contains(fileType)) {
            throw new IllegalArgumentException("Only PDF and common image files are supported");
        }

        String documentId = UUID.randomUUID().toString();
        Path stagedPath = batchTemp.resolve(documentId + ".upload");
        try {
            try (InputStream input = file.getInputStream()) {
                Files.copy(input, stagedPath, StandardCopyOption.REPLACE_EXISTING);
            }

            if (Files.size(stagedPath) == 0) {
                throw new IllegalArgumentException("Empty files are not supported");
            }

            List<Page> pages = inspectPages(documentId, fileType, stagedPath);
            String mimeType = normalizeMimeType(file.getContentType(), fileType);
            Document document =
                    new Document(
                            documentId,
                            batchId,
                            originalFilename,
                            "",
                            fileType,
                            mimeType,
                            sha256(stagedPath),
                            Files.size(stagedPath),
                            pages.size(),
                            "unknown",
                            DocumentStatus.IMPORTED,
                            "p0",
                            pages);
            return new StagedDocument(document, stagedPath);
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(stagedPath);
            throw e;
        }
    }

    private void validateReviewAction(Document document, SaveReviewActionRequest request) {
        if (request.targetType() == null) {
            throw new IllegalArgumentException("Review target type is required");
        }
        if (request.targetId() == null || request.targetId().isBlank()) {
            throw new IllegalArgumentException("Review target id is required");
        }
        if (request.targetId().length() > 200) {
            throw new IllegalArgumentException("Review target id must be 200 characters or fewer");
        }
        if (request.action() == null) {
            throw new IllegalArgumentException("Review action type is required");
        }
        if ((request.action() == ReviewActionType.SELECT_TEXT
                        || request.action() == ReviewActionType.DESELECT_TEXT)
                && request.targetType() != ReviewTargetType.TEXT_REGION) {
            throw new IllegalArgumentException(
                    "Text selection actions require a text region target");
        }
        if ((request.action() == ReviewActionType.ADD_MANUAL
                        || request.action() == ReviewActionType.DELETE_MANUAL
                        || request.action() == ReviewActionType.MOVE
                        || request.action() == ReviewActionType.RESIZE)
                && request.targetType() != ReviewTargetType.MANUAL_RECTANGLE) {
            throw new IllegalArgumentException(
                    "Manual rectangle action has an invalid target type");
        }
        if (request.before() == null && request.after() == null) {
            throw new IllegalArgumentException("Review action must include before or after state");
        }
        validateReviewState(document, request.before());
        validateReviewState(document, request.after());
    }

    private void validateReviewState(Document document, ReviewActionState state) {
        if (state == null) {
            return;
        }
        validateShortValue(state.entityType(), "Entity type");
        validateShortValue(state.entityRole(), "Entity role");
        if (state.selectionState() == null) {
            throw new IllegalArgumentException("Selection state is required");
        }
        if (state.selectionSource() == null) {
            throw new IllegalArgumentException("Selection source is required");
        }
        RedactionBox box = state.box();
        if (box == null) {
            return;
        }
        Page page =
                document.pages().stream()
                        .filter(item -> item.id().equals(box.pageId()))
                        .findFirst()
                        .orElseThrow(
                                () ->
                                        new IllegalArgumentException(
                                                "Review action page does not belong to document"));
        if (!Float.isFinite(box.x())
                || !Float.isFinite(box.y())
                || !Float.isFinite(box.width())
                || !Float.isFinite(box.height())
                || box.x() < 0
                || box.y() < 0
                || box.width() <= 0
                || box.height() <= 0
                || box.x() + box.width() > page.width() + 0.5f
                || box.y() + box.height() > page.height() + 0.5f) {
            throw new IllegalArgumentException("Review action box is invalid");
        }
    }

    private void validateShortValue(String value, String label) {
        if (value != null && value.length() > 80) {
            throw new IllegalArgumentException(label + " must be 80 characters or fewer");
        }
    }

    private Document withStatus(Document document, DocumentStatus status) {
        return new Document(
                document.id(),
                document.batchId(),
                document.originalFilename(),
                document.sourceRelativePath(),
                document.fileType(),
                document.mimeType(),
                document.sha256(),
                document.fileSize(),
                document.pageCount(),
                document.documentType(),
                status,
                document.processingVersion(),
                document.pages());
    }

    private List<Page> inspectPages(String documentId, String fileType, Path path)
            throws IOException {
        if ("pdf".equals(fileType)) {
            try (PDDocument pdf = Loader.loadPDF(path.toFile())) {
                List<Page> pages = new ArrayList<>(pdf.getNumberOfPages());
                for (int index = 0; index < pdf.getNumberOfPages(); index++) {
                    PDPage pdfPage = pdf.getPage(index);
                    pages.add(
                            new Page(
                                    documentId
                                            + "-P"
                                            + String.format(Locale.ROOT, "%04d", index + 1),
                                    documentId,
                                    index + 1,
                                    pdfPage.getCropBox().getWidth(),
                                    pdfPage.getCropBox().getHeight(),
                                    SourceKind.PDF,
                                    pdfPage.getRotation(),
                                    null,
                                    PageStatus.IMPORTED));
                }
                return List.copyOf(pages);
            }
        }

        BufferedImage image = ImageIO.read(path.toFile());
        if (image == null) {
            throw new IllegalArgumentException("The image file could not be decoded");
        }
        return List.of(
                new Page(
                        documentId + "-P0001",
                        documentId,
                        1,
                        image.getWidth(),
                        image.getHeight(),
                        SourceKind.IMAGE,
                        0,
                        null,
                        PageStatus.IMPORTED));
    }

    private void createBatchDirectories(String batchId) throws IOException {
        Files.createDirectories(sourceRoot.resolve(batchId));
        Files.createDirectories(pagesRoot.resolve(batchId));
        Files.createDirectories(cacheRoot.resolve(batchId));
        Files.createDirectories(tempRoot.resolve(batchId));
        Files.createDirectories(outputRoot.resolve(batchId));
        Files.createDirectories(reportsRoot.resolve(batchId));
    }

    private record KnownEntityContext(List<KnownEntity> entities) {}

    private void persistKnownEntityContext(String batchId, List<KnownEntity> entities)
            throws IOException {
        if (entities.isEmpty()) {
            return;
        }
        Path target = knownEntityContextFile(batchId);
        Path temp = target.resolveSibling(target.getFileName().toString() + ".tmp");
        objectMapper
                .writerWithDefaultPrettyPrinter()
                .writeValue(temp.toFile(), new KnownEntityContext(entities));
        moveAtomically(temp, target);
    }

    private Path knownEntityContextFile(String batchId) {
        return batchesRoot.resolve(batchId + ".context");
    }

    private void persistBatch(Batch batch) throws IOException {
        Path target = batchFile(batch.id());
        Path temp = target.resolveSibling(target.getFileName().toString() + ".tmp");
        objectMapper.writerWithDefaultPrettyPrinter().writeValue(temp.toFile(), batch);
        moveAtomically(temp, target);
    }

    private Batch readBatchFile(Path file) throws IOException {
        if (!Files.isRegularFile(file)) {
            throw new NoSuchElementException("Batch not found");
        }
        return objectMapper.readValue(file.toFile(), Batch.class);
    }

    private Path batchFile(String batchId) {
        return batchesRoot.resolve(batchId + ".json");
    }

    private String validateBatchId(String batchId) {
        if (batchId == null) {
            throw new IllegalArgumentException("Batch id is required");
        }
        try {
            UUID parsed = UUID.fromString(batchId);
            if (!parsed.toString().equalsIgnoreCase(batchId)) {
                throw new IllegalArgumentException("Invalid batch id");
            }
            return parsed.toString();
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid batch id", e);
        }
    }

    private List<KnownEntity> normalizeKnownEntities(List<KnownEntity> knownEntities) {
        if (knownEntities == null || knownEntities.isEmpty()) {
            return List.of();
        }
        if (knownEntities.size() > 100) {
            throw new IllegalArgumentException("Known entity context is limited to 100 entries");
        }

        List<KnownEntity> normalized = new ArrayList<>();
        for (KnownEntity entity : knownEntities) {
            if (entity == null || entity.entityType() == null || entity.value() == null) {
                throw new IllegalArgumentException("Known entity type and value are required");
            }
            String entityType = entity.entityType().trim().toUpperCase(Locale.ROOT);
            String value = entity.value().trim();
            String entityRole =
                    entity.entityRole() == null || entity.entityRole().isBlank()
                            ? null
                            : entity.entityRole().trim().toUpperCase(Locale.ROOT);
            if (!KNOWN_ENTITY_TYPES.contains(entityType)) {
                throw new IllegalArgumentException("Unsupported known entity type");
            }
            if (value.isEmpty() || value.length() > 256) {
                throw new IllegalArgumentException(
                        "Known entity values must contain 1 to 256 characters");
            }
            if (entityRole != null && entityRole.length() > 32) {
                throw new IllegalArgumentException("Known entity role is too long");
            }
            normalized.add(new KnownEntity(entityType, value, entityRole));
        }
        return List.copyOf(normalized);
    }

    private String normalizeBatchName(String requestedName) {
        String name = requestedName == null ? "" : requestedName.trim();
        if (name.isEmpty()) {
            return "脱敏任务 " + DEFAULT_NAME_FORMAT.format(Instant.now());
        }
        if (name.length() > 120) {
            throw new IllegalArgumentException("Batch name must be 120 characters or fewer");
        }
        return name;
    }

    private String safeOriginalFilename(String originalFilename) {
        String value = originalFilename == null ? "" : originalFilename.trim();
        value = value.replace('\\', '/');
        int slash = value.lastIndexOf('/');
        if (slash >= 0) {
            value = value.substring(slash + 1);
        }
        if (value.isBlank() || ".".equals(value) || "..".equals(value)) {
            throw new IllegalArgumentException("A valid filename is required");
        }
        return value;
    }

    private String extensionOf(String filename) {
        int dot = filename.lastIndexOf('.');
        if (dot < 0 || dot == filename.length() - 1) {
            return "";
        }
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private String normalizeMimeType(String contentType, String fileType) {
        if (contentType != null && !contentType.isBlank()) {
            return contentType;
        }
        return switch (fileType) {
            case "pdf" -> "application/pdf";
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "tif", "tiff" -> "image/tiff";
            case "bmp" -> "image/bmp";
            default -> "application/octet-stream";
        };
    }

    private String sha256(Path path) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private String aggregateSourceHash(List<Document> documents) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
        for (Document document : documents) {
            digest.update(document.sha256().getBytes(StandardCharsets.UTF_8));
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private String toWorkspaceRelativePath(Path path) {
        return workspaceRoot.relativize(path).toString().replace(File.separatorChar, '/');
    }

    private void markReadOnly(Path path) throws IOException {
        PosixFileAttributeView posixView =
                Files.getFileAttributeView(path, PosixFileAttributeView.class);
        if (posixView != null) {
            Set<PosixFilePermission> permissions =
                    EnumSet.copyOf(posixView.readAttributes().permissions());
            permissions.remove(PosixFilePermission.OWNER_WRITE);
            permissions.remove(PosixFilePermission.GROUP_WRITE);
            permissions.remove(PosixFilePermission.OTHERS_WRITE);
            posixView.setPermissions(permissions);
        } else if (!path.toFile().setReadOnly()) {
            throw new IOException("Unable to mark source file as read-only");
        }
    }

    private void makeWritable(Path path) {
        try {
            PosixFileAttributeView posixView =
                    Files.getFileAttributeView(path, PosixFileAttributeView.class);
            if (posixView != null && Files.isRegularFile(path)) {
                Set<PosixFilePermission> permissions =
                        EnumSet.copyOf(posixView.readAttributes().permissions());
                permissions.add(PosixFilePermission.OWNER_WRITE);
                posixView.setPermissions(permissions);
            } else if (Files.exists(path)) {
                path.toFile().setWritable(true);
            }
        } catch (IOException ignored) {
            path.toFile().setWritable(true);
        }
    }

    private void moveAtomically(Path source, Path target) throws IOException {
        try {
            Files.move(
                    source,
                    target,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void deleteDirectoryIfEmpty(Path directory) throws IOException {
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (var children = Files.list(directory)) {
            if (children.findAny().isEmpty()) {
                Files.deleteIfExists(directory);
            }
        }
    }

    public record SourceFile(Document document, Path path) {}

    public record OutputFile(Document document, VerificationReport report, Path path) {}

    private record StagedDocument(Document document, Path stagedPath) {}
}
