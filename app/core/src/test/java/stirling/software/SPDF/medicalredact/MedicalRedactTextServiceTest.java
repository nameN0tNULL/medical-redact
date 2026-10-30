package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.AlignmentPolygon;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Batch;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CandidateAlignment;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.KnownEntity;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.OcrPageResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiCandidate;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiDetectResponse;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PolygonPoint;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextPageMode;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextToken;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.WorkerSchedule;

import tools.jackson.databind.ObjectMapper;

class MedicalRedactTextServiceTest {

    @TempDir Path tempDir;

    @Test
    void nativePdfTextProducesStableClickableRegionsWithoutCallingOcr() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("native-text").id(),
                        List.of(pdfWithText("record.pdf", "Patient: Zhang San 12345")));
        AtomicInteger ocrCalls = new AtomicInteger();
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return false;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                ocrCalls.incrementAndGet();
                                return unavailable("UNEXPECTED_OCR_CALL");
                            }
                        });

        var first = service.extract(imported.id(), imported.documents().getFirst().id());
        var second = service.extract(imported.id(), imported.documents().getFirst().id());

        assertEquals(0, ocrCalls.get());
        assertEquals(TextPageMode.PDF_TEXT, first.pages().getFirst().mode());
        assertFalse(first.pages().getFirst().tokens().isEmpty());
        assertEquals(
                first.pages().getFirst().regions().stream().map(region -> region.id()).toList(),
                second.pages().getFirst().regions().stream().map(region -> region.id()).toList());
        assertTrue(
                first.pages().getFirst().regions().stream()
                        .allMatch(region -> region.source() == TextSource.PDF_TEXT));
        assertTrue(
                first.pages().getFirst().regions().stream()
                        .allMatch(
                                region ->
                                        region.polygon().stream()
                                                .allMatch(
                                                        point ->
                                                                point.x() >= 0 && point.y() >= 0)));
    }

    @Test
    void complexChineseNativePdfKeepsClickableGeometryWithoutCallingOcr() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("complex-native").id(),
                        List.of(complexChinesePdf("complex.pdf")));
        AtomicInteger ocrCalls = new AtomicInteger();
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return false;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                ocrCalls.incrementAndGet();
                                return unavailable("UNEXPECTED_OCR_CALL");
                            }
                        });

        var first = service.extract(imported.id(), imported.documents().getFirst().id());
        var second = service.extract(imported.id(), imported.documents().getFirst().id());

        assertEquals(0, ocrCalls.get());
        assertFalse(first.engineAvailable());
        assertEquals(2, first.pages().size());
        assertTrue(first.pages().stream().allMatch(page -> page.mode() == TextPageMode.PDF_TEXT));
        assertTrue(first.pages().stream().allMatch(page -> page.tokens().size() >= 8));
        assertEquals(
                first.pages().stream()
                        .flatMap(page -> page.regions().stream())
                        .map(region -> region.id())
                        .toList(),
                second.pages().stream()
                        .flatMap(page -> page.regions().stream())
                        .map(region -> region.id())
                        .toList());

        String extracted =
                first.pages().stream()
                        .flatMap(page -> page.tokens().stream())
                        .map(TextToken::text)
                        .reduce("", String::concat);
        assertTrue(extracted.contains("测试患者甲"));
        assertTrue(extracted.contains("ZY-20261024-0007"));
        assertTrue(extracted.contains("13800000001"));
        assertTrue(extracted.contains("EXAM-CT-20261024-09"));
        assertTrue(extracted.contains("ALT"));
        assertTrue(extracted.contains("CREA"));
        assertTrue(extracted.contains("11010119900307451X"));

        var allTokens = first.pages().stream().flatMap(page -> page.tokens().stream()).toList();
        assertTrue(
                allTokens.stream()
                        .allMatch(
                                token ->
                                        token.lineId() != null
                                                && !token.lineId().isBlank()
                                                && token.blockId() != null
                                                && !token.blockId().isBlank()
                                                && token.charBoxes() != null
                                                && !token.charBoxes().isEmpty()));
        assertTrue(
                allTokens.stream()
                        .flatMap(token -> token.polygon().stream())
                        .allMatch(
                                point ->
                                        point.x() >= 0
                                                && point.y() >= 0
                                                && point.x() <= PDRectangle.A4.getWidth()
                                                && point.y() <= PDRectangle.A4.getHeight()));
        assertTrue(
                first.pages().getFirst().tokens().stream()
                        .anyMatch(
                                token ->
                                        token.polygon().stream()
                                                        .mapToDouble(PolygonPoint::x)
                                                        .min()
                                                        .orElseThrow()
                                                < 200));
        assertTrue(
                first.pages().getFirst().tokens().stream()
                        .anyMatch(
                                token ->
                                        token.polygon().stream()
                                                        .mapToDouble(PolygonPoint::x)
                                                        .min()
                                                        .orElseThrow()
                                                > 300));
        assertTrue(
                first.pages().getFirst().tokens().stream()
                                .map(TextToken::blockId)
                                .distinct()
                                .count()
                        >= 2);
    }

    @Test
    void pageWithoutTextUsesOcrContractAndNormalizesSource() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("scan").id(), List.of(blankPdf("scan.pdf")));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                assertEquals(document.id(), request.documentId());
                                assertEquals(page.id(), request.pageId());
                                assertFalse(request.imageBase64().isBlank());
                                return new OcrPageResponse(
                                        true,
                                        "paddleocr",
                                        "test",
                                        List.of(
                                                new TextToken(
                                                        "ocr-token-1",
                                                        "患者",
                                                        page.id(),
                                                        rectangle(20, 30, 80, 50),
                                                        0.99,
                                                        "line-1",
                                                        "block-1",
                                                        TextSource.LOCAL_REOCR,
                                                        null)),
                                        null,
                                        5);
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                assertEquals(1, request.pageImages().size());
                                assertEquals(page.id(), request.pageImages().getFirst().pageId());
                                assertFalse(
                                        request.pageImages().getFirst().imageBase64().isBlank());
                                return new PiiDetectResponse(true, List.of(), null);
                            }
                        });

        var extracted = service.extract(imported.id(), document.id());

        assertTrue(extracted.engineAvailable());
        assertEquals(TextPageMode.PADDLE_OCR, extracted.pages().getFirst().mode());
        assertEquals(1, extracted.pages().getFirst().regions().size());
        assertEquals(
                TextSource.PADDLE_OCR, extracted.pages().getFirst().regions().getFirst().source());
    }

    @Test
    void pageImageCacheKeepsOnlyMostRecentPagesForPiiLocalReocr() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("bounded-cache").id(),
                        List.of(blankPdf("scan.pdf", 6)));
        var document = imported.documents().getFirst();
        MedicalRedactWorkerScheduler scheduler =
                new MedicalRedactWorkerScheduler(
                        new WorkerSchedule("TEST", 1, 1, 2, 3, "SMALL", false));
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return new OcrPageResponse(
                                        true,
                                        "paddleocr",
                                        "test",
                                        List.of(
                                                new TextToken(
                                                        "ocr-token-" + request.pageNo(),
                                                        "患者",
                                                        request.pageId(),
                                                        rectangle(20, 30, 80, 50),
                                                        0.99,
                                                        "line-" + request.pageNo(),
                                                        "block-" + request.pageNo(),
                                                        TextSource.PADDLE_OCR,
                                                        null)),
                                        null,
                                        5);
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                assertEquals(
                                        List.of(4, 5, 6),
                                        request.pageImages().stream()
                                                .map(OcrPageRequest::pageNo)
                                                .toList());
                                return new PiiDetectResponse(true, List.of(), null);
                            }
                        },
                        scheduler);

        var extracted = service.extract(imported.id(), document.id());

        assertEquals(6, extracted.pages().size());
        assertTrue(
                extracted.pages().stream()
                        .allMatch(page -> page.mode() == TextPageMode.PADDLE_OCR));
    }

    @Test
    void deterministicPiiCandidatesAutoSelectTheExistingTextRegion() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace
                                .createBatch(
                                        "pii-auto",
                                        List.of(new KnownEntity("PHONE", "13800000001", "PATIENT")))
                                .id(),
                        List.of(pdfWithText("record.pdf", "Phone 13800000001")));
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return unavailable("UNEXPECTED_OCR_CALL");
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                assertEquals(1, request.knownEntities().size());
                                assertEquals(
                                        "PHONE", request.knownEntities().getFirst().entityType());
                                assertEquals(
                                        "PATIENT", request.knownEntities().getFirst().entityRole());
                                TextToken matched =
                                        request.tokens().stream()
                                                .filter(token -> token.text().contains("138"))
                                                .findFirst()
                                                .orElseThrow();
                                return new PiiDetectResponse(
                                        true,
                                        List.of(
                                                new PiiCandidate(
                                                        "pii-test",
                                                        "PHONE",
                                                        null,
                                                        6,
                                                        17,
                                                        6,
                                                        17,
                                                        0.96,
                                                        0.96,
                                                        "presidio-cn-mobile-phone",
                                                        List.of("presidio-cn-mobile-phone"),
                                                        List.of(matched.pageId()),
                                                        List.of(matched.id()),
                                                        new CandidateAlignment(
                                                                "B",
                                                                0.96,
                                                                "TOKEN_FULL",
                                                                List.of(
                                                                        new AlignmentPolygon(
                                                                                matched.pageId(),
                                                                                matched.polygon())),
                                                                List.of(),
                                                                false,
                                                                false),
                                                        "AUTO_SELECT",
                                                        "RESOLVED",
                                                        false)),
                                        null);
                            }
                        });

        var extracted = service.extract(imported.id(), imported.documents().getFirst().id());
        var candidate = extracted.piiCandidates().getFirst();
        var selectedRegion =
                extracted.pages().stream()
                        .flatMap(page -> page.regions().stream())
                        .filter(
                                region ->
                                        region.tokenIds().contains(candidate.tokenIds().getFirst()))
                        .findFirst()
                        .orElseThrow();

        assertTrue(extracted.piiAvailable());
        assertEquals("PHONE", candidate.entityType());
        assertEquals(SelectionState.SELECTED, selectedRegion.selectionState());
        assertEquals(SelectionSource.PII_AUTO, selectedRegion.selectionSource());
    }

    @Test
    void reviewPolicyCandidateDoesNotAutoSelectTheTextRegion() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(
                        new ObjectMapper(), tempDir.resolve("review-policy"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("review-policy").id(),
                        List.of(pdfWithText("record.pdf", "Phone 13800000001")));
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return unavailable("UNEXPECTED_OCR_CALL");
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                TextToken matched =
                                        request.tokens().stream()
                                                .filter(token -> token.text().contains("138"))
                                                .findFirst()
                                                .orElseThrow();
                                return new PiiDetectResponse(
                                        true,
                                        List.of(
                                                new PiiCandidate(
                                                        "pii-review",
                                                        "DOCTOR_NAME",
                                                        "DOCTOR",
                                                        6,
                                                        17,
                                                        6,
                                                        17,
                                                        0.9,
                                                        0.9,
                                                        "ner-context-doctor-name",
                                                        List.of("ner-context-doctor-name"),
                                                        List.of(matched.pageId()),
                                                        List.of(matched.id()),
                                                        new CandidateAlignment(
                                                                "A",
                                                                1.0,
                                                                "PDF_NATIVE_CHAR",
                                                                List.of(
                                                                        new AlignmentPolygon(
                                                                                matched.pageId(),
                                                                                matched.polygon())),
                                                                List.of(),
                                                                false,
                                                                false),
                                                        "REVIEW",
                                                        "REVIEW",
                                                        false)),
                                        null);
                            }
                        });

        var extracted = service.extract(imported.id(), imported.documents().getFirst().id());
        var candidate = extracted.piiCandidates().getFirst();
        var region =
                extracted.pages().stream()
                        .flatMap(page -> page.regions().stream())
                        .filter(item -> item.tokenIds().contains(candidate.tokenIds().getFirst()))
                        .findFirst()
                        .orElseThrow();

        assertEquals("REVIEW", candidate.policy());
        assertEquals(SelectionState.UNSELECTED, region.selectionState());
        assertEquals(SelectionSource.NONE, region.selectionSource());
    }

    @Test
    void knownValueVerificationCoversExactNormalizedSpacingAndOcrConfusions() {
        assertTrue(MedicalRedactTextService.knownValueSurvived("张三", "患者：张三"));
        assertTrue(MedicalRedactTextService.knownValueSurvived("Ａ１２３４", "A1234"));
        assertTrue(MedicalRedactTextService.knownValueSurvived("13800000001", "138 0000 0001"));
        assertTrue(MedicalRedactTextService.knownValueSurvived("13800000001", "138OOOOOOO1"));
        assertFalse(MedicalRedactTextService.knownValueSurvived("13800000001", "13900000001"));
    }

    @Test
    void outputVerificationBlocksWhenKnownValueSurvivesOcr() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(
                        new ObjectMapper(), tempDir.resolve("known-value-scan"));
        Batch imported =
                workspace.importDocuments(
                        workspace
                                .createBatch(
                                        "known-value-scan",
                                        List.of(new KnownEntity("PHONE", "13800000001", "PATIENT")))
                                .id(),
                        List.of(blankPdf("output.pdf")));
        var document = imported.documents().getFirst();
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return new OcrPageResponse(
                                        true,
                                        "paddleocr",
                                        "test",
                                        List.of(
                                                new TextToken(
                                                        "output-token",
                                                        "13800000001",
                                                        request.pageId(),
                                                        rectangle(20, 20, 180, 40),
                                                        0.99,
                                                        "line-1",
                                                        "block-1",
                                                        TextSource.PADDLE_OCR,
                                                        null)),
                                        null,
                                        2);
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                return new PiiDetectResponse(true, List.of(), null);
                            }
                        });

        List<String> findings =
                service.verifyRedactedOutput(
                        imported.id(),
                        document,
                        workspace.openSource(imported.id(), document.id()).path());

        assertTrue(findings.contains("KNOWN_VALUE_SURVIVED"));
        assertFalse(findings.contains("OUTPUT_OCR_UNAVAILABLE"));

        var issues =
                service.verifyRedactedOutputIssues(
                        imported.id(),
                        document,
                        workspace.openSource(imported.id(), document.id()).path());
        var issue =
                issues.stream()
                        .filter(item -> "MR-VERIFY-7004".equals(item.code()))
                        .findFirst()
                        .orElseThrow();
        assertEquals(document.pages().getFirst().id(), issue.pageId());
        assertEquals(document.pages().getFirst().pageNo(), issue.params().get("pageNo"));
        assertEquals("PHONE", issue.params().get("entityType"));
        assertTrue(issue.params().containsKey("x"));
        assertTrue(issue.params().containsKey("y"));
        assertTrue(issue.params().containsKey("width"));
        assertTrue(issue.params().containsKey("height"));
    }

    @Test
    void outputVerificationBlocksWhenCorePiiIsRedetected() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(
                        new ObjectMapper(), tempDir.resolve("output-pii-scan"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("output-pii-scan").id(),
                        List.of(blankPdf("output.pdf")));
        var document = imported.documents().getFirst();
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return true;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return new OcrPageResponse(
                                        true,
                                        "paddleocr",
                                        "test",
                                        List.of(
                                                new TextToken(
                                                        "output-token",
                                                        "13800000001",
                                                        request.pageId(),
                                                        rectangle(20, 20, 180, 40),
                                                        0.99,
                                                        "line-1",
                                                        "block-1",
                                                        TextSource.PADDLE_OCR,
                                                        null)),
                                        null,
                                        2);
                            }

                            @Override
                            public PiiDetectResponse detectPii(PiiDetectRequest request) {
                                TextToken token = request.tokens().getFirst();
                                return new PiiDetectResponse(
                                        true,
                                        List.of(
                                                new PiiCandidate(
                                                        "output-phone",
                                                        "PHONE",
                                                        null,
                                                        0,
                                                        11,
                                                        0,
                                                        11,
                                                        0.96,
                                                        0.96,
                                                        "presidio-cn-mobile-phone",
                                                        List.of("presidio-cn-mobile-phone"),
                                                        List.of(token.pageId()),
                                                        List.of(token.id()),
                                                        new CandidateAlignment(
                                                                "B",
                                                                0.96,
                                                                "TOKEN_FULL",
                                                                List.of(
                                                                        new AlignmentPolygon(
                                                                                token.pageId(),
                                                                                token.polygon())),
                                                                List.of(),
                                                                false,
                                                                false),
                                                        "AUTO_SELECT",
                                                        "RESOLVED",
                                                        false)),
                                        null);
                            }
                        });

        List<String> findings =
                service.verifyRedactedOutput(
                        imported.id(),
                        document,
                        workspace.openSource(imported.id(), document.id()).path());

        assertTrue(findings.contains("OUTPUT_PII_DETECTED"));

        var issues =
                service.verifyRedactedOutputIssues(
                        imported.id(),
                        document,
                        workspace.openSource(imported.id(), document.id()).path());
        var issue =
                issues.stream()
                        .filter(item -> "MR-VERIFY-7005".equals(item.code()))
                        .findFirst()
                        .orElseThrow();
        assertEquals("output-phone", issue.candidateId());
        assertEquals(document.pages().getFirst().id(), issue.pageId());
        assertEquals(document.pages().getFirst().pageNo(), issue.params().get("pageNo"));
        assertEquals("PHONE", issue.params().get("entityType"));
        assertTrue(issue.params().containsKey("x"));
        assertTrue(issue.params().containsKey("y"));
    }

    @Test
    void unavailableOcrFallsBackWithoutBreakingManualReviewFlow() throws Exception {
        MedicalRedactWorkspaceService workspace =
                new MedicalRedactWorkspaceService(new ObjectMapper(), tempDir.resolve("workspace"));
        Batch imported =
                workspace.importDocuments(
                        workspace.createBatch("no-engine").id(), List.of(blankPdf("scan.pdf")));
        MedicalRedactTextService service =
                new MedicalRedactTextService(
                        workspace,
                        new MedicalRedactOcrGateway() {
                            @Override
                            public boolean isHealthy() {
                                return false;
                            }

                            @Override
                            public OcrPageResponse recognize(OcrPageRequest request) {
                                return unavailable("AI_ENGINE_DISABLED");
                            }
                        });

        var extracted = service.extract(imported.id(), imported.documents().getFirst().id());

        assertFalse(extracted.engineAvailable());
        assertEquals(TextPageMode.OCR_UNAVAILABLE, extracted.pages().getFirst().mode());
        assertTrue(extracted.pages().getFirst().tokens().isEmpty());
        assertTrue(extracted.pages().getFirst().regions().isEmpty());
        assertEquals("MR-RUNTIME-9001", extracted.pages().getFirst().warningCode());
        assertTrue(
                workspace.openSource(imported.id(), imported.documents().getFirst().id()) != null);
    }

    private OcrPageResponse unavailable(String warningCode) {
        return new OcrPageResponse(false, "paddleocr", null, List.of(), warningCode, 0);
    }

    private List<PolygonPoint> rectangle(float left, float top, float right, float bottom) {
        return List.of(
                new PolygonPoint(left, top),
                new PolygonPoint(right, top),
                new PolygonPoint(right, bottom),
                new PolygonPoint(left, bottom));
    }

    private MockMultipartFile blankPdf(String filename) throws Exception {
        return blankPdf(filename, 1);
    }

    private MockMultipartFile blankPdf(String filename, int pageCount) throws Exception {
        try (PDDocument document = new PDDocument();
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            for (int page = 0; page < pageCount; page++) {
                document.addPage(new PDPage(PDRectangle.A4));
            }
            document.save(output);
            return new MockMultipartFile(
                    "files", filename, "application/pdf", output.toByteArray());
        }
    }

    private MockMultipartFile complexChinesePdf(String filename) throws Exception {
        Path fontPath = Path.of("src/main/resources/static/fonts/NotoSansSC-Regular.ttf");
        try (PDDocument document = new PDDocument();
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            PDFont font = PDType0Font.load(document, fontPath.toFile());

            PDPage first = new PDPage(PDRectangle.A4);
            document.addPage(first);
            try (PDPageContentStream content = new PDPageContentStream(document, first)) {
                drawText(content, font, 14, 55, 790, "虚构住院病历 - 多栏测试");
                drawText(content, font, 11, 55, 740, "左栏姓名：测试患者甲");
                drawText(content, font, 11, 55, 710, "住院号：ZY-20261024-0007");
                drawText(content, font, 11, 55, 680, "身份证：");
                drawText(content, font, 11, 118, 680, "11010119900307451X");
                drawText(content, font, 11, 330, 740, "右栏电话：13800000001");
                drawText(content, font, 11, 330, 710, "检查号：EXAM-CT-20261024-09");
                drawText(content, font, 11, 330, 680, "诊断：E2E测试 Diagnosis-01");
            }

            PDPage second = new PDPage(PDRectangle.A4);
            document.addPage(second);
            try (PDPageContentStream content = new PDPageContentStream(document, second)) {
                drawText(content, font, 13, 55, 790, "虚构检验表格");
                float[] xs = {55, 190, 320, 445};
                String[][] rows = {
                    {"项目", "结果", "单位", "参考"},
                    {"ALT", "22", "U/L", "0-40"},
                    {"CREA", "71", "umol/L", "40-100"},
                    {"RBC", "4.62", "10^12/L", "4.30-5.80"}
                };
                float y = 735;
                for (String[] row : rows) {
                    for (int column = 0; column < row.length; column++) {
                        drawText(content, font, 11, xs[column], y, row[column]);
                    }
                    y -= 34;
                }
            }

            document.save(output);
            return new MockMultipartFile(
                    "files", filename, "application/pdf", output.toByteArray());
        }
    }

    private void drawText(
            PDPageContentStream content, PDFont font, float size, float x, float y, String text)
            throws Exception {
        content.beginText();
        content.setFont(font, size);
        content.newLineAtOffset(x, y);
        content.showText(text);
        content.endText();
    }

    private MockMultipartFile pdfWithText(String filename, String text) throws Exception {
        try (PDDocument document = new PDDocument();
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                content.newLineAtOffset(72, 720);
                content.showText(text);
                content.endText();
            }
            document.save(output);
            return new MockMultipartFile(
                    "files", filename, "application/pdf", output.toByteArray());
        }
    }
}
