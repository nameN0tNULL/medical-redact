package stirling.software.SPDF.medicalredact;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import javax.imageio.ImageIO;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.CandidateAlignment;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CharacterBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Document;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.KnownEntity;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Page;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PageTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiCandidate;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PolygonPoint;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RedactionBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectableTextRegion;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextPageMode;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextToken;
import stirling.software.SPDF.medicalredact.MedicalRedactWorkspaceService.SourceFile;

@Service
public class MedicalRedactTextService {

    private static final int OCR_RENDER_DPI = 200;
    private static final Set<String> OUTPUT_CORE_PII_TYPES =
            Set.of(
                    "PATIENT_NAME",
                    "CN_ID_CARD",
                    "PHONE",
                    "FIXED_PHONE",
                    "EMAIL",
                    "BANK_CARD",
                    "DATE_OF_BIRTH",
                    "MEDICAL_RECORD_NO",
                    "INPATIENT_NO",
                    "OUTPATIENT_NO",
                    "INSURANCE_NO",
                    "PATIENT_ID",
                    "EXAM_NO",
                    "SAMPLE_NO",
                    "HOME_ADDRESS");

    private final MedicalRedactWorkspaceService workspaceService;
    private final MedicalRedactOcrGateway ocrGateway;
    private final MedicalRedactWorkerScheduler workerScheduler;

    @Autowired
    public MedicalRedactTextService(
            MedicalRedactWorkspaceService workspaceService,
            MedicalRedactOcrGateway ocrGateway,
            MedicalRedactWorkerScheduler workerScheduler) {
        this.workspaceService = workspaceService;
        this.ocrGateway = ocrGateway;
        this.workerScheduler = workerScheduler;
    }

    MedicalRedactTextService(
            MedicalRedactWorkspaceService workspaceService, MedicalRedactOcrGateway ocrGateway) {
        this(
                workspaceService,
                ocrGateway,
                new MedicalRedactWorkerScheduler(
                        new MedicalRedactModels.WorkerSchedule(
                                "TEST_DEFAULT", 1, 1, 2, 4, "SMALL", false)));
    }

    public DocumentTextRegions extract(String batchId, String documentId) throws IOException {
        SourceFile source = workspaceService.openSource(batchId, documentId);
        Document document = source.document();
        ExtractionResult extracted =
                "pdf".equals(document.fileType())
                        ? extractPdf(document, source.path())
                        : extractImage(document, source.path());
        return attachPii(
                extracted.regions(),
                workspaceService.getKnownEntities(batchId),
                extracted.pageImages(),
                document);
    }

    List<String> verifyRedactedOutput(String batchId, Document document, Path outputPath)
            throws IOException {
        return verifyRedactedOutputIssues(batchId, document, outputPath).stream()
                .map(
                        issue ->
                                issue.legacyCode() == null || issue.legacyCode().isBlank()
                                        ? issue.code()
                                        : issue.legacyCode())
                .distinct()
                .toList();
    }

    List<MedicalRedactIssue> verifyRedactedOutputIssues(
            String batchId, Document document, Path outputPath) throws IOException {
        List<MedicalRedactIssue> findings = new ArrayList<>();
        List<TextToken> outputTokens = new ArrayList<>();
        PageImageCache pageImages = new PageImageCache(workerScheduler.renderCachePages());
        List<KnownEntity> knownEntities = workspaceService.getKnownEntities(batchId);

        try (PDDocument output = Loader.loadPDF(outputPath.toFile())) {
            PDFRenderer renderer = new PDFRenderer(output);
            int pageCount = Math.min(output.getNumberOfPages(), document.pages().size());
            for (int index = 0; index < pageCount; index++) {
                Page page = document.pages().get(index);
                OcrPageRequest request = renderOcrRequest(document, page, renderer, index);
                pageImages.put(request);
                OcrPageResponse response =
                        workerScheduler.runOcr(() -> ocrGateway.recognize(request));
                if (!response.available()) {
                    findings.add(
                            verificationIssue(
                                    MedicalRedactIssueCode.MR_VERIFY_7006,
                                    "OUTPUT_OCR_UNAVAILABLE",
                                    document,
                                    page,
                                    null,
                                    null,
                                    null));
                    continue;
                }

                List<TextToken> pageTokens =
                        response.tokens() == null
                                ? List.of()
                                : response.tokens().stream()
                                        .filter(token -> validOcrToken(page, token))
                                        .toList();
                outputTokens.addAll(pageTokens);
                String pageText =
                        pageTokens.stream()
                                .map(TextToken::text)
                                .reduce("", (left, right) -> left + "\n" + right);
                String compactPageText =
                        pageTokens.stream().map(TextToken::text).reduce("", String::concat);
                for (KnownEntity entity : knownEntities) {
                    String value = entity.value();
                    if (value == null || value.isBlank()) {
                        continue;
                    }
                    if (knownValueSurvived(value, pageText)
                            || knownValueSurvived(value, compactPageText)) {
                        findings.add(
                                verificationIssue(
                                        MedicalRedactIssueCode.MR_VERIFY_7004,
                                        "KNOWN_VALUE_SURVIVED",
                                        document,
                                        page,
                                        null,
                                        entity.entityType(),
                                        locateKnownValueBox(page.id(), pageTokens, value)));
                    }
                }
            }
        }

        if (!outputTokens.isEmpty()) {
            PiiDetectResponse pii =
                    workerScheduler.runNer(
                            () ->
                                    ocrGateway.detectPii(
                                            new PiiDetectRequest(
                                                    document.id(),
                                                    outputTokens,
                                                    List.of(),
                                                    pageImages.values())));
            if (!pii.available()) {
                findings.add(
                        verificationIssue(
                                MedicalRedactIssueCode.MR_VERIFY_7007,
                                "OUTPUT_PII_SCAN_UNAVAILABLE",
                                document,
                                null,
                                null,
                                null,
                                null));
            } else if (pii.candidates() != null) {
                for (PiiCandidate candidate : pii.candidates()) {
                    if (candidate == null
                            || !OUTPUT_CORE_PII_TYPES.contains(candidate.entityType())) {
                        continue;
                    }
                    RedactionBox box = candidateBox(candidate);
                    Page page =
                            box == null
                                    ? firstCandidatePage(document, candidate)
                                    : document.pages().stream()
                                            .filter(item -> item.id().equals(box.pageId()))
                                            .findFirst()
                                            .orElse(null);
                    findings.add(
                            verificationIssue(
                                    MedicalRedactIssueCode.MR_VERIFY_7005,
                                    "OUTPUT_PII_DETECTED",
                                    document,
                                    page,
                                    candidate.id(),
                                    candidate.entityType(),
                                    box));
                }
            }
        }

        return List.copyOf(findings);
    }

    private MedicalRedactIssue verificationIssue(
            MedicalRedactIssueCode code,
            String legacyCode,
            Document document,
            Page page,
            String candidateId,
            String entityType,
            RedactionBox box) {
        Map<String, Object> params = new LinkedHashMap<>();
        if (page != null) {
            params.put("pageNo", page.pageNo());
        }
        if (entityType != null && !entityType.isBlank()) {
            params.put("entityType", entityType);
        }
        if (box != null) {
            params.put("x", box.x());
            params.put("y", box.y());
            params.put("width", box.width());
            params.put("height", box.height());
        }
        return new MedicalRedactIssue(
                code.code(),
                code.severity(),
                params,
                document.id(),
                page == null ? box == null ? null : box.pageId() : page.id(),
                candidateId,
                null,
                legacyCode);
    }

    private Page firstCandidatePage(Document document, PiiCandidate candidate) {
        if (candidate.pageIds() == null || candidate.pageIds().isEmpty()) {
            return null;
        }
        String pageId = candidate.pageIds().getFirst();
        return document.pages().stream()
                .filter(page -> page.id().equals(pageId))
                .findFirst()
                .orElse(null);
    }

    private RedactionBox candidateBox(PiiCandidate candidate) {
        if (candidate.alignment() == null
                || candidate.alignment().polygons() == null
                || candidate.alignment().polygons().isEmpty()) {
            return null;
        }
        for (var polygon : candidate.alignment().polygons()) {
            RedactionBox box = polygonBox(polygon.pageId(), polygon.points());
            if (box != null) {
                return box;
            }
        }
        return null;
    }

    private RedactionBox locateKnownValueBox(
            String pageId, List<TextToken> pageTokens, String knownValue) {
        for (int start = 0; start < pageTokens.size(); start++) {
            StringBuilder text = new StringBuilder();
            for (int end = start; end < Math.min(pageTokens.size(), start + 8); end++) {
                TextToken token = pageTokens.get(end);
                if (token.text() != null) {
                    text.append(token.text());
                }
                if (knownValueSurvived(knownValue, text.toString())) {
                    return tokenUnionBox(pageId, pageTokens.subList(start, end + 1));
                }
            }
        }
        return null;
    }

    private RedactionBox tokenUnionBox(String pageId, List<TextToken> tokens) {
        List<PolygonPoint> points =
                tokens.stream()
                        .filter(token -> token.polygon() != null)
                        .flatMap(token -> token.polygon().stream())
                        .toList();
        return polygonBox(pageId, points);
    }

    private RedactionBox polygonBox(String pageId, List<PolygonPoint> points) {
        if (points == null || points.size() < 4) {
            return null;
        }
        float left = Float.MAX_VALUE;
        float top = Float.MAX_VALUE;
        float right = -Float.MAX_VALUE;
        float bottom = -Float.MAX_VALUE;
        for (PolygonPoint point : points) {
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

    static boolean knownValueSurvived(String knownValue, String outputText) {
        if (knownValue == null
                || knownValue.isBlank()
                || outputText == null
                || outputText.isBlank()) {
            return false;
        }
        if (outputText.contains(knownValue)) {
            return true;
        }

        String normalizedNeedle = normalizeForVerification(knownValue);
        String normalizedOutput = normalizeForVerification(outputText);
        if (!normalizedNeedle.isBlank() && normalizedOutput.contains(normalizedNeedle)) {
            return true;
        }

        String compactNeedle = stripVerificationSpacing(normalizedNeedle);
        String compactOutput = stripVerificationSpacing(normalizedOutput);
        if (!compactNeedle.isBlank() && compactOutput.contains(compactNeedle)) {
            return true;
        }

        if (compactNeedle.length() < 4) {
            return false;
        }
        String confusionNeedle = normalizeOcrConfusions(compactNeedle);
        String confusionOutput = normalizeOcrConfusions(compactOutput);
        return !confusionNeedle.isBlank() && confusionOutput.contains(confusionNeedle);
    }

    private static String normalizeForVerification(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFKC).toUpperCase(Locale.ROOT);
    }

    private static String stripVerificationSpacing(String value) {
        StringBuilder result = new StringBuilder(value.length());
        value.codePoints()
                .filter(codePoint -> !Character.isWhitespace(codePoint) && codePoint != 0x00A0)
                .forEach(result::appendCodePoint);
        return result.toString();
    }

    private static String normalizeOcrConfusions(String value) {
        StringBuilder result = new StringBuilder(value.length());
        value.codePoints()
                .forEach(
                        codePoint -> {
                            int normalized =
                                    switch (codePoint) {
                                        case 'O', 0x3007, 0x25CB -> '0';
                                        case 'I', 'L', '|', 0x4E28 -> '1';
                                        case 'S' -> '5';
                                        case 'B' -> '8';
                                        default -> codePoint;
                                    };
                            result.appendCodePoint(normalized);
                        });
        return result.toString();
    }

    private ExtractionResult extractPdf(Document document, Path sourcePath) throws IOException {
        List<PageTextRegions> pages = new ArrayList<>(document.pages().size());
        PageImageCache pageImages = new PageImageCache(workerScheduler.renderCachePages());
        boolean engineAvailable = false;
        try (PDDocument pdf = Loader.loadPDF(sourcePath.toFile())) {
            PDFRenderer renderer = new PDFRenderer(pdf);
            for (int index = 0; index < document.pages().size(); index++) {
                long started = System.nanoTime();
                Page page = document.pages().get(index);
                PageTokenStripper stripper = new PageTokenStripper(page);
                stripper.getText(pdf);
                List<TextToken> nativeTokens = stripper.tokens();
                if (isReliableTextLayer(nativeTokens)) {
                    pages.add(
                            new PageTextRegions(
                                    page.id(),
                                    page.pageNo(),
                                    TextPageMode.PDF_TEXT,
                                    nativeTokens,
                                    buildRegions(document.id(), page, nativeTokens),
                                    null,
                                    elapsedMillis(started)));
                    continue;
                }

                OcrPageRequest ocrRequest = renderOcrRequest(document, page, renderer, index);
                OcrPageResponse ocr =
                        workerScheduler.runOcr(() -> ocrGateway.recognize(ocrRequest));
                pageImages.put(ocrRequest);
                engineAvailable |= ocr.available();
                pages.add(fromOcrResponse(document, page, ocr, started));
            }
        }
        return new ExtractionResult(
                new DocumentTextRegions(
                        document.id(), List.copyOf(pages), engineAvailable, false, List.of()),
                pageImages.values());
    }

    private ExtractionResult extractImage(Document document, Path sourcePath) throws IOException {
        Page page = document.pages().getFirst();
        long started = System.nanoTime();
        OcrPageRequest ocrRequest =
                workerScheduler.runPreprocess(
                        () -> {
                            BufferedImage image = ImageIO.read(sourcePath.toFile());
                            if (image == null) {
                                throw new IllegalArgumentException(
                                        "The image file could not be decoded");
                            }
                            try {
                                return ocrRequest(document, page, image, encodePng(image));
                            } finally {
                                image.flush();
                            }
                        });
        OcrPageResponse ocr = workerScheduler.runOcr(() -> ocrGateway.recognize(ocrRequest));
        return new ExtractionResult(
                new DocumentTextRegions(
                        document.id(),
                        List.of(fromOcrResponse(document, page, ocr, started)),
                        ocr.available(),
                        false,
                        List.of()),
                List.of(ocrRequest));
    }

    private DocumentTextRegions attachPii(
            DocumentTextRegions extracted,
            List<KnownEntity> knownEntities,
            List<OcrPageRequest> pageImages,
            Document document) {
        List<TextToken> tokens =
                extracted.pages().stream().flatMap(page -> page.tokens().stream()).toList();
        if (tokens.isEmpty()) {
            return extracted;
        }

        PiiDetectResponse response =
                workerScheduler.runNer(
                        () ->
                                ocrGateway.detectPii(
                                        new PiiDetectRequest(
                                                extracted.documentId(),
                                                tokens,
                                                knownEntities,
                                                pageImages)));
        List<PiiCandidate> candidates =
                response.candidates() == null
                        ? List.of()
                        : response.candidates().stream()
                                .filter(candidate -> candidate != null)
                                .map(
                                        candidate ->
                                                hardenCandidateAlignment(
                                                        extracted, document, candidate))
                                .toList();
        if (!response.available() || candidates.isEmpty()) {
            return new DocumentTextRegions(
                    extracted.documentId(),
                    extracted.pages(),
                    extracted.engineAvailable(),
                    response.available(),
                    candidates);
        }

        Set<String> selectedTokenIds = new HashSet<>();
        candidates.stream()
                .filter(this::shouldAutoSelect)
                .forEach(candidate -> selectedTokenIds.addAll(candidate.tokenIds()));
        List<PageTextRegions> pages =
                extracted.pages().stream()
                        .map(
                                page ->
                                        new PageTextRegions(
                                                page.pageId(),
                                                page.pageNo(),
                                                page.mode(),
                                                page.tokens(),
                                                page.regions().stream()
                                                        .map(
                                                                region ->
                                                                        autoSelectRegion(
                                                                                region,
                                                                                selectedTokenIds))
                                                        .toList(),
                                                page.warningCode(),
                                                page.elapsedMs()))
                        .toList();
        return new DocumentTextRegions(
                extracted.documentId(), pages, extracted.engineAvailable(), true, candidates);
    }

    private PiiCandidate hardenCandidateAlignment(
            DocumentTextRegions extracted, Document document, PiiCandidate candidate) {
        candidate = normalizeCandidateWarnings(candidate);
        CandidateAlignment alignment = candidate.alignment();
        if (candidate.tokenIds() == null || candidate.tokenIds().isEmpty()) {
            return unresolvedCandidate(candidate, "TOKEN_REGION_MAPPING_CONFLICT");
        }

        for (String tokenId : candidate.tokenIds()) {
            long matches =
                    extracted.pages().stream()
                            .flatMap(page -> page.regions().stream())
                            .filter(region -> region.tokenIds().contains(tokenId))
                            .count();
            if (matches != 1) {
                return unresolvedCandidate(candidate, "TOKEN_REGION_MAPPING_CONFLICT");
            }
        }

        if (alignment == null || alignment.polygons() == null || alignment.polygons().isEmpty()) {
            return unresolvedCandidate(candidate, "MISSING_BBOX");
        }
        if (alignment.polygons().stream()
                .anyMatch(
                        polygon -> {
                            Page page =
                                    document.pages().stream()
                                            .filter(item -> item.id().equals(polygon.pageId()))
                                            .findFirst()
                                            .orElse(null);
                            return page == null || !validPolygon(page, polygon.points());
                        })) {
            return unresolvedCandidate(candidate, "BBOX_OUT_OF_BOUNDS");
        }
        return candidate;
    }

    private boolean validPolygon(Page page, List<PolygonPoint> points) {
        if (points == null || points.size() < 4) {
            return false;
        }
        float left = Float.MAX_VALUE;
        float top = Float.MAX_VALUE;
        float right = -Float.MAX_VALUE;
        float bottom = -Float.MAX_VALUE;
        for (PolygonPoint point : points) {
            if (point == null
                    || !Float.isFinite(point.x())
                    || !Float.isFinite(point.y())
                    || point.x() < 0
                    || point.y() < 0
                    || point.x() > page.width() + 0.5f
                    || point.y() > page.height() + 0.5f) {
                return false;
            }
            left = Math.min(left, point.x());
            top = Math.min(top, point.y());
            right = Math.max(right, point.x());
            bottom = Math.max(bottom, point.y());
        }
        return right > left && bottom > top;
    }

    private PiiCandidate unresolvedCandidate(PiiCandidate candidate, String warning) {
        CandidateAlignment existing = candidate.alignment();
        List<String> warnings = new ArrayList<>();
        if (existing != null && existing.warnings() != null) {
            warnings.addAll(MedicalRedactIssueMapper.protocolCodes(existing.warnings()));
        }
        String issueCode = MedicalRedactIssueMapper.protocolCode(warning);
        if (!warnings.contains(issueCode)) {
            warnings.add(issueCode);
        }
        CandidateAlignment unresolved =
                new CandidateAlignment(
                        "D",
                        0.0,
                        "UNRESOLVED",
                        existing == null || existing.polygons() == null
                                ? List.of()
                                : existing.polygons(),
                        List.copyOf(warnings),
                        false,
                        true);
        return new PiiCandidate(
                candidate.id(),
                candidate.entityType(),
                candidate.entityRole(),
                candidate.normalizedStart(),
                candidate.normalizedEnd(),
                candidate.sourceStart(),
                candidate.sourceEnd(),
                candidate.confidence(),
                0.0,
                candidate.detector(),
                candidate.detectorEvidence(),
                candidate.pageIds(),
                candidate.tokenIds(),
                unresolved,
                "REVIEW",
                "UNRESOLVED",
                candidate.conflict());
    }

    private PiiCandidate normalizeCandidateWarnings(PiiCandidate candidate) {
        CandidateAlignment alignment = candidate.alignment();
        if (alignment == null || alignment.warnings() == null || alignment.warnings().isEmpty()) {
            return candidate;
        }
        List<String> warnings = MedicalRedactIssueMapper.protocolCodes(alignment.warnings());
        CandidateAlignment normalizedAlignment =
                new CandidateAlignment(
                        alignment.level(),
                        alignment.confidence(),
                        alignment.method(),
                        alignment.polygons(),
                        warnings,
                        alignment.needsLocalReocr(),
                        alignment.unresolved());
        return new PiiCandidate(
                candidate.id(),
                candidate.entityType(),
                candidate.entityRole(),
                candidate.normalizedStart(),
                candidate.normalizedEnd(),
                candidate.sourceStart(),
                candidate.sourceEnd(),
                candidate.confidence(),
                candidate.overallConfidence(),
                candidate.detector(),
                candidate.detectorEvidence(),
                candidate.pageIds(),
                candidate.tokenIds(),
                normalizedAlignment,
                candidate.policy(),
                candidate.riskStatus(),
                candidate.conflict());
    }

    private boolean shouldAutoSelect(PiiCandidate candidate) {
        return candidate != null
                && "AUTO_SELECT".equals(candidate.policy())
                && "RESOLVED".equals(candidate.riskStatus())
                && !candidate.conflict()
                && candidate.alignment() != null
                && !candidate.alignment().unresolved()
                && !candidate.alignment().polygons().isEmpty();
    }

    private SelectableTextRegion autoSelectRegion(
            SelectableTextRegion region, Set<String> selectedTokenIds) {
        if (region.tokenIds().stream().noneMatch(selectedTokenIds::contains)) {
            return region;
        }
        return new SelectableTextRegion(
                region.id(),
                region.documentId(),
                region.pageId(),
                region.tokenIds(),
                region.polygon(),
                region.source(),
                region.confidence(),
                SelectionState.SELECTED,
                SelectionSource.PII_AUTO);
    }

    private PageTextRegions fromOcrResponse(
            Document document, Page page, OcrPageResponse ocr, long started) {
        if (!ocr.available()) {
            return new PageTextRegions(
                    page.id(),
                    page.pageNo(),
                    TextPageMode.OCR_UNAVAILABLE,
                    List.of(),
                    List.of(),
                    MedicalRedactIssueMapper.protocolCodeOrNull(ocr.warningCode()),
                    elapsedMillis(started));
        }

        List<TextToken> tokens =
                ocr.tokens().stream()
                        .filter(token -> validOcrToken(page, token))
                        .map(
                                token ->
                                        new TextToken(
                                                token.id(),
                                                token.text(),
                                                page.id(),
                                                List.copyOf(token.polygon()),
                                                token.confidence(),
                                                token.lineId(),
                                                token.blockId(),
                                                TextSource.PADDLE_OCR,
                                                token.charBoxes() == null
                                                        ? null
                                                        : List.copyOf(token.charBoxes())))
                        .toList();
        return new PageTextRegions(
                page.id(),
                page.pageNo(),
                TextPageMode.PADDLE_OCR,
                tokens,
                buildRegions(document.id(), page, tokens),
                MedicalRedactIssueMapper.protocolCodeOrNull(ocr.warningCode()),
                elapsedMillis(started));
    }

    private OcrPageRequest renderOcrRequest(
            Document document, Page page, PDFRenderer renderer, int pageIndex) throws IOException {
        return workerScheduler.runPreprocess(
                () -> {
                    BufferedImage rendered =
                            renderer.renderImageWithDPI(pageIndex, OCR_RENDER_DPI, ImageType.RGB);
                    try {
                        return ocrRequest(document, page, rendered, encodePng(rendered));
                    } finally {
                        rendered.flush();
                    }
                });
    }

    private OcrPageRequest ocrRequest(
            Document document, Page page, BufferedImage image, String imageBase64) {
        return new OcrPageRequest(
                document.id(),
                page.id(),
                page.pageNo(),
                page.width(),
                page.height(),
                image.getWidth(),
                image.getHeight(),
                imageBase64,
                "STANDARD");
    }

    private boolean validOcrToken(Page page, TextToken token) {
        if (token == null
                || token.id() == null
                || token.id().isBlank()
                || token.text() == null
                || token.text().isBlank()
                || !page.id().equals(token.pageId())
                || token.polygon() == null
                || token.polygon().size() < 4) {
            return false;
        }
        return token.polygon().stream()
                .allMatch(
                        point ->
                                point != null
                                        && Float.isFinite(point.x())
                                        && Float.isFinite(point.y())
                                        && point.x() >= -1
                                        && point.y() >= -1
                                        && point.x() <= page.width() + 1
                                        && point.y() <= page.height() + 1);
    }

    private boolean isReliableTextLayer(List<TextToken> tokens) {
        int visibleCharacters =
                tokens.stream()
                        .mapToInt(token -> token.text().codePointCount(0, token.text().length()))
                        .sum();
        return !tokens.isEmpty() && visibleCharacters >= 2;
    }

    private List<SelectableTextRegion> buildRegions(
            String documentId, Page page, List<TextToken> tokens) {
        return tokens.stream()
                .map(
                        token ->
                                new SelectableTextRegion(
                                        "region-" + stableId(documentId, page.id(), token.id()),
                                        documentId,
                                        page.id(),
                                        List.of(token.id()),
                                        token.polygon(),
                                        token.source(),
                                        token.confidence(),
                                        SelectionState.UNSELECTED,
                                        SelectionSource.NONE))
                .toList();
    }

    private String encodePng(BufferedImage image) throws IOException {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!ImageIO.write(image, "png", output)) {
                throw new IOException("PNG encoder is unavailable");
            }
            return Base64.getEncoder().encodeToString(output.toByteArray());
        }
    }

    private long elapsedMillis(long startedNanos) {
        return Math.max(0, (System.nanoTime() - startedNanos) / 1_000_000);
    }

    private static String stableId(String... parts) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
        for (String part : parts) {
            digest.update(part.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
        }
        return HexFormat.of().formatHex(digest.digest()).substring(0, 20);
    }

    private static final class PageImageCache {

        private final int maxPages;
        private final LinkedHashMap<String, OcrPageRequest> pages = new LinkedHashMap<>();

        private PageImageCache(int maxPages) {
            this.maxPages = Math.max(1, maxPages);
        }

        private void put(OcrPageRequest request) {
            pages.remove(request.pageId());
            pages.put(request.pageId(), request);
            while (pages.size() > maxPages) {
                String oldestPageId = pages.keySet().iterator().next();
                pages.remove(oldestPageId);
            }
        }

        private List<OcrPageRequest> values() {
            return List.copyOf(pages.values());
        }
    }

    private record ExtractionResult(DocumentTextRegions regions, List<OcrPageRequest> pageImages) {}

    private static final class PageTokenStripper extends PDFTextStripper {

        private static final float LINE_TOLERANCE = 3f;
        private static final int MAX_TOKEN_CHARS = 12;

        private final Page page;
        private final List<TextToken> tokens = new ArrayList<>();
        private int ordinal;

        private PageTokenStripper(Page page) throws IOException {
            this.page = page;
            setStartPage(page.pageNo());
            setEndPage(page.pageNo());
            setSortByPosition(true);
        }

        private List<TextToken> tokens() {
            return List.copyOf(tokens);
        }

        @Override
        protected void writeString(String text, List<TextPosition> positions) {
            List<TextPosition> current = new ArrayList<>();
            for (TextPosition position : positions) {
                if (!isVisible(position)) {
                    flush(current);
                    continue;
                }
                if (!current.isEmpty() && shouldSplit(current.getLast(), position, current)) {
                    flush(current);
                }
                current.add(position);
            }
            flush(current);
        }

        private boolean isVisible(TextPosition position) {
            String unicode = position.getUnicode();
            float x = position.getX();
            float top = position.getY() - position.getHeight();
            float width = position.getWidth();
            float height = position.getHeight();
            return unicode != null
                    && !unicode.isBlank()
                    && Float.isFinite(x)
                    && Float.isFinite(top)
                    && Float.isFinite(width)
                    && Float.isFinite(height)
                    && width > 0.2f
                    && height > 0.2f
                    && x < page.width() + 1
                    && top < page.height() + 1
                    && x + width > -1
                    && top + height > -1;
        }

        private boolean shouldSplit(
                TextPosition previous, TextPosition next, List<TextPosition> current) {
            float previousTop = previous.getY() - previous.getHeight();
            float nextTop = next.getY() - next.getHeight();
            float gap = next.getX() - (previous.getX() + previous.getWidth());
            int characters =
                    current.stream()
                            .map(TextPosition::getUnicode)
                            .filter(value -> value != null)
                            .mapToInt(value -> value.codePointCount(0, value.length()))
                            .sum();
            float gapThreshold = Math.max(4f, previous.getHeight() * 0.8f);
            return Math.abs(previousTop - nextTop) > LINE_TOLERANCE
                    || gap > gapThreshold
                    || characters >= MAX_TOKEN_CHARS;
        }

        private void flush(List<TextPosition> positions) {
            if (positions.isEmpty()) {
                return;
            }
            StringBuilder text = new StringBuilder();
            List<CharacterBox> charBoxes = new ArrayList<>(positions.size());
            float minX = Float.MAX_VALUE;
            float minY = Float.MAX_VALUE;
            float maxX = -Float.MAX_VALUE;
            float maxY = -Float.MAX_VALUE;
            for (TextPosition position : positions) {
                String unicode = position.getUnicode();
                if (unicode == null || unicode.isBlank()) {
                    continue;
                }
                float x = Math.max(0, position.getX());
                float y = Math.max(0, position.getY() - position.getHeight());
                float right = Math.min(page.width(), position.getX() + position.getWidth());
                float bottom = Math.min(page.height(), position.getY());
                if (right <= x || bottom <= y) {
                    continue;
                }
                List<PolygonPoint> polygon = rectangle(x, y, right, bottom);
                text.append(unicode);
                charBoxes.add(new CharacterBox(unicode, polygon));
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, right);
                maxY = Math.max(maxY, bottom);
            }
            positions.clear();
            if (text.isEmpty() || minX == Float.MAX_VALUE) {
                return;
            }

            ordinal++;
            String tokenId =
                    "token-"
                            + stableId(
                                    page.id(),
                                    Integer.toString(ordinal),
                                    quantized(minX),
                                    quantized(minY),
                                    quantized(maxX),
                                    quantized(maxY));
            tokens.add(
                    new TextToken(
                            tokenId,
                            text.toString(),
                            page.id(),
                            rectangle(minX, minY, maxX, maxY),
                            1.0,
                            page.id() + "-L" + String.format(Locale.ROOT, "%05d", Math.round(minY)),
                            blockId(minX),
                            TextSource.PDF_TEXT,
                            List.copyOf(charBoxes)));
        }

        private String blockId(float minX) {
            float columnWidth = Math.max(1f, page.width() / 3f);
            int column = Math.max(0, Math.min(2, (int) (minX / columnWidth)));
            return page.id() + "-B" + String.format(Locale.ROOT, "%04d", column + 1);
        }

        private static String quantized(float value) {
            return Integer.toString(Math.round(value * 10));
        }

        private static List<PolygonPoint> rectangle(
                float left, float top, float right, float bottom) {
            return List.of(
                    new PolygonPoint(left, top),
                    new PolygonPoint(right, top),
                    new PolygonPoint(right, bottom),
                    new PolygonPoint(left, bottom));
        }
    }
}
