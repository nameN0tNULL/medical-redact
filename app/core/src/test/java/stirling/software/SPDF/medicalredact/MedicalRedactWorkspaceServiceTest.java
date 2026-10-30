package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;

import javax.imageio.ImageIO;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.mock.web.MockMultipartFile;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.AlignmentPolygon;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Batch;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.BatchStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.CandidateAlignment;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.DocumentTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.KnownEntity;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PageTextRegions;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PiiCandidate;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.PolygonPoint;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RedactionBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewTargetType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SaveReviewActionRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectableTextRegion;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextPageMode;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.TextToken;

import tools.jackson.databind.ObjectMapper;

class MedicalRedactWorkspaceServiceTest {

    @TempDir Path tempDir;

    @Test
    void springCanInstantiateWorkspaceService() {
        String previous = System.getProperty("medical-redact.workspace-path");
        System.setProperty(
                "medical-redact.workspace-path", tempDir.resolve("spring-workspace").toString());
        try (AnnotationConfigApplicationContext context =
                new AnnotationConfigApplicationContext()) {
            context.getBeanFactory().registerSingleton("objectMapper", new ObjectMapper());
            context.register(MedicalRedactWorkspaceService.class);
            context.refresh();
            assertTrue(context.getBean(MedicalRedactWorkspaceService.class) != null);
        } finally {
            if (previous == null) {
                System.clearProperty("medical-redact.workspace-path");
            } else {
                System.setProperty("medical-redact.workspace-path", previous);
            }
        }
    }

    @Test
    void knownEntityContextStaysOutOfBatchMetadataAndSurvivesRestart() throws Exception {
        Path workspace = tempDir.resolve("known-context");
        ObjectMapper objectMapper = new ObjectMapper();
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(objectMapper, workspace);

        Batch batch =
                service.createBatch(
                        "known-context",
                        List.of(new KnownEntity("PATIENT_NAME", "测试患者甲", "PATIENT")));

        assertFalse(objectMapper.writeValueAsString(batch).contains("测试患者甲"));
        assertEquals(
                List.of(new KnownEntity("PATIENT_NAME", "测试患者甲", "PATIENT")),
                service.getKnownEntities(batch.id()));

        MedicalRedactWorkspaceService restarted =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        assertEquals("测试患者甲", restarted.getKnownEntities(batch.id()).getFirst().value());
    }

    @Test
    void importsThreePdfsAndRecoversThemAfterRestart() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch created = service.createBatch("住院病历脱敏");

        Batch imported =
                service.importDocuments(
                        created.id(), List.of(pdf("a.pdf", 1), pdf("b.pdf", 2), pdf("c.pdf", 3)));

        assertEquals(BatchStatus.IMPORTED, imported.status());
        assertEquals(3, imported.documentCount());
        assertEquals(3, imported.documents().size());
        assertEquals(64, imported.sourceHash().length());
        assertEquals(
                List.of(1, 2, 3), imported.documents().stream().map(d -> d.pageCount()).toList());

        for (var document : imported.documents()) {
            assertEquals(64, document.sha256().length());
            assertFalse(
                    Path.of(document.sourceRelativePath())
                            .getFileName()
                            .toString()
                            .equals(document.originalFilename()));
            Path source = workspace.resolve(document.sourceRelativePath());
            assertTrue(Files.isRegularFile(source));
            assertSourceReadOnlyWhenPosix(source);
        }

        MedicalRedactWorkspaceService restarted =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        List<Batch> recovered = restarted.listBatches();

        assertEquals(1, recovered.size());
        assertEquals(imported.id(), recovered.getFirst().id());
        assertEquals(3, recovered.getFirst().documents().size());
    }

    @Test
    void invalidImportLeavesNoSensitiveTempFile() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch batch = service.createBatch("invalid-image");
        MockMultipartFile invalid =
                new MockMultipartFile(
                        "files", "broken.png", "image/png", "not-an-image".getBytes());

        assertThrows(
                IllegalArgumentException.class,
                () -> service.importDocuments(batch.id(), List.of(invalid)));

        try (var paths = Files.walk(workspace.resolve("temp"))) {
            assertEquals(0, paths.filter(Files::isRegularFile).count());
        }
    }

    @Test
    void cleanupTempDeletesOnlyTemporaryFiles() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch batch = service.createBatch("cleanup");
        Batch imported = service.importDocuments(batch.id(), List.of(pdf("source.pdf", 1)));

        Path temporary = workspace.resolve("temp").resolve("leftover.tmp");
        Files.writeString(temporary, "temporary");
        var result = service.cleanupTemp();

        assertEquals(1, result.deletedFiles());
        assertFalse(Files.exists(temporary));
        Path source = workspace.resolve(imported.documents().getFirst().sourceRelativePath());
        assertTrue(Files.isRegularFile(source));
    }

    @Test
    void savesReviewActionsAsAppendOnlyEventsAndRecoversThemAfterRestart() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("manual-review").id(), List.of(pdf("source.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        ReviewActionState after =
                new ReviewActionState(
                        "PATIENT_NAME",
                        "PATIENT",
                        new RedactionBox(page.id(), 20, 30, 100, 24),
                        SelectionState.SELECTED,
                        SelectionSource.MANUAL_RECTANGLE);

        Batch reviewed =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-box-1",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                after));

        assertEquals(BatchStatus.IN_REVIEW, reviewed.status());
        assertEquals(DocumentStatus.IN_REVIEW, reviewed.documents().getFirst().status());
        assertEquals(1, reviewed.reviewActions().size());
        assertEquals(after, reviewed.reviewActions().getFirst().after());
        assertEquals("local-user", reviewed.reviewActions().getFirst().operatorId());

        MedicalRedactWorkspaceService restarted =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch recovered = restarted.getBatch(imported.id());
        assertEquals(1, recovered.reviewActions().size());
        assertEquals(ReviewActionType.ADD_MANUAL, recovered.reviewActions().getFirst().action());
    }

    @Test
    void rejectsReviewBoxForAnotherDocumentPage() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("manual-review").id(),
                        List.of(pdf("one.pdf", 1), pdf("two.pdf", 1)));
        var first = imported.documents().getFirst();
        var secondPage = imported.documents().get(1).pages().getFirst();

        assertThrows(
                IllegalArgumentException.class,
                () ->
                        service.saveReviewAction(
                                imported.id(),
                                new SaveReviewActionRequest(
                                        first.id(),
                                        ReviewTargetType.MANUAL_RECTANGLE,
                                        "manual-box-1",
                                        ReviewActionType.ADD_MANUAL,
                                        null,
                                        new ReviewActionState(
                                                "OTHER",
                                                null,
                                                new RedactionBox(secondPage.id(), 1, 1, 10, 10),
                                                SelectionState.SELECTED,
                                                SelectionSource.MANUAL_RECTANGLE))));
    }

    @Test
    void blocksFinalizationUntilAtLeastOneApprovedBoxExists() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("blocked").id(), List.of(pdf("source.pdf", 1)));

        Batch blocked =
                service.finalizeDocument(imported.id(), imported.documents().getFirst().id());

        assertEquals(BatchStatus.BLOCKED, blocked.status());
        assertEquals(DocumentStatus.BLOCKED, blocked.documents().getFirst().status());
        assertEquals("BLOCKED", blocked.verificationReports().getFirst().status());
        assertEquals(1, blocked.verificationReports().getFirst().findingCount());
        assertThrows(
                IllegalStateException.class,
                () -> service.openOutput(imported.id(), imported.documents().getFirst().id()));
    }

    @Test
    void deselectedTextRegionIsExcludedFromFinalRedactionSelection() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("text-selection").id(), List.of(pdf("source.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        ReviewActionState selected =
                new ReviewActionState(
                        "PATIENT_NAME",
                        "PATIENT",
                        new RedactionBox(page.id(), 40, 50, 120, 36),
                        SelectionState.SELECTED,
                        SelectionSource.USER);
        ReviewActionState deselected =
                new ReviewActionState(
                        "PATIENT_NAME",
                        "PATIENT",
                        selected.box(),
                        SelectionState.UNSELECTED,
                        SelectionSource.USER);

        Batch withSelection =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.TEXT_REGION,
                                "text-region-1",
                                ReviewActionType.SELECT_TEXT,
                                null,
                                selected));
        Batch withoutSelection =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.TEXT_REGION,
                                "text-region-1",
                                ReviewActionType.DESELECT_TEXT,
                                selected,
                                deselected));

        assertEquals(2, withoutSelection.reviewActions().size());
        assertEquals(
                ReviewActionType.SELECT_TEXT, withSelection.reviewActions().getFirst().action());
        Batch blocked = service.finalizeDocument(withoutSelection.id(), document.id());
        assertEquals("BLOCKED", blocked.verificationReports().getFirst().status());
    }

    @Test
    void unresolvedPiiBlocksUntilExistingTextRegionIsSelected() throws Exception {
        Path workspace = tempDir.resolve("workspace-risk");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("risk-review").id(), List.of(pdf("risk.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        List<PolygonPoint> polygon =
                List.of(
                        new PolygonPoint(40, 50),
                        new PolygonPoint(160, 50),
                        new PolygonPoint(160, 86),
                        new PolygonPoint(40, 86));
        TextToken token =
                new TextToken(
                        "risk-token",
                        "13800000001",
                        page.id(),
                        polygon,
                        0.65,
                        "line-1",
                        "block-1",
                        TextSource.PADDLE_OCR,
                        null);
        SelectableTextRegion region =
                new SelectableTextRegion(
                        "risk-region",
                        document.id(),
                        page.id(),
                        List.of(token.id()),
                        polygon,
                        TextSource.PADDLE_OCR,
                        0.65,
                        SelectionState.UNSELECTED,
                        SelectionSource.NONE);
        PiiCandidate risk =
                new PiiCandidate(
                        "risk-candidate",
                        "PHONE",
                        null,
                        0,
                        11,
                        0,
                        11,
                        0.96,
                        0.0,
                        "presidio-cn-mobile-phone",
                        List.of("presidio-cn-mobile-phone"),
                        List.of(page.id()),
                        List.of(token.id()),
                        new CandidateAlignment(
                                "D",
                                0.0,
                                "LOCAL_REOCR_FAILED",
                                List.of(new AlignmentPolygon(page.id(), polygon)),
                                List.of("LOCAL_REOCR_NO_SAFE_MATCH"),
                                false,
                                true),
                        "REVIEW",
                        "UNRESOLVED",
                        false);
        DocumentTextRegions textRegions =
                new DocumentTextRegions(
                        document.id(),
                        List.of(
                                new PageTextRegions(
                                        page.id(),
                                        page.pageNo(),
                                        TextPageMode.PADDLE_OCR,
                                        List.of(token),
                                        List.of(region),
                                        null,
                                        0)),
                        true,
                        true,
                        List.of(risk));

        Batch withUnrelatedBox =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-unrelated",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                new ReviewActionState(
                                        "OTHER",
                                        null,
                                        new RedactionBox(page.id(), 250, 250, 20, 20),
                                        SelectionState.SELECTED,
                                        SelectionSource.MANUAL_RECTANGLE)));

        Batch blocked = service.finalizeDocument(withUnrelatedBox.id(), document.id(), textRegions);
        assertEquals(BatchStatus.BLOCKED, blocked.status());
        assertEquals("BLOCKED", blocked.verificationReports().getFirst().status());
        assertEquals(
                "MR-VERIFY-7002",
                blocked.verificationReports().getFirst().issues().getFirst().code());
        var unresolvedIssue = blocked.verificationReports().getFirst().issues().getFirst();
        assertEquals(page.id(), unresolvedIssue.pageId());
        assertEquals("risk-candidate", unresolvedIssue.candidateId());
        assertEquals(page.pageNo(), unresolvedIssue.params().get("pageNo"));
        assertEquals("PHONE", unresolvedIssue.params().get("entityType"));
        assertEquals("UNRESOLVED", unresolvedIssue.params().get("riskStatus"));
        assertTrue(unresolvedIssue.params().containsKey("x"));
        assertTrue(unresolvedIssue.params().containsKey("y"));

        ReviewActionState selected =
                new ReviewActionState(
                        "PHONE",
                        null,
                        new RedactionBox(page.id(), 40, 50, 120, 36),
                        SelectionState.SELECTED,
                        SelectionSource.USER);
        Batch repaired =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.TEXT_REGION,
                                region.id(),
                                ReviewActionType.SELECT_TEXT,
                                null,
                                selected));

        Batch verified = service.finalizeDocument(repaired.id(), document.id(), textRegions);
        assertEquals(BatchStatus.VERIFIED, verified.status());
        assertEquals("PASS", verified.verificationReports().getFirst().status());
    }

    @Test
    void finalizesSelectedBoxesAsVerifiedRasterOnlyPdf() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("secure-raster").id(),
                        List.of(pdf("patient-name.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        String sourceHash = document.sha256();
        Batch reviewed =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-box-1",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                new ReviewActionState(
                                        "PATIENT_NAME",
                                        "PATIENT",
                                        new RedactionBox(page.id(), 40, 50, 120, 36),
                                        SelectionState.SELECTED,
                                        SelectionSource.MANUAL_RECTANGLE)));

        Batch verified = service.finalizeDocument(reviewed.id(), document.id());

        assertEquals(BatchStatus.VERIFIED, verified.status());
        assertEquals(DocumentStatus.VERIFIED, verified.documents().getFirst().status());
        var report = verified.verificationReports().getFirst();
        assertEquals("PASS", report.status());
        assertEquals(0, report.findingCount());
        assertTrue(report.outputFilename().startsWith("DOC"));
        assertFalse(report.outputFilename().contains("patient-name"));
        assertEquals(64, report.sha256().length());
        assertEquals(sourceHash, service.getBatch(imported.id()).documents().getFirst().sha256());

        var output = service.openOutput(imported.id(), document.id());
        assertTrue(Files.isRegularFile(output.path()));
        try (PDDocument pdf = org.apache.pdfbox.Loader.loadPDF(output.path().toFile())) {
            assertEquals(1, pdf.getNumberOfPages());
            assertTrue(new PDFTextStripper().getText(pdf).isBlank());

            BufferedImage rendered = new PDFRenderer(pdf).renderImageWithDPI(0, 72, ImageType.RGB);
            assertDarkPixel(rendered, 39, 60);
            assertDarkPixel(rendered, 60, 49);
            assertLightPixel(rendered, 36, 60);
            assertLightPixel(rendered, 60, 46);

            assertTrue(pdf.getDocumentInformation().getMetadataKeys().isEmpty());
            assertTrue(pdf.getDocumentCatalog().getMetadata() == null);
            assertTrue(pdf.getDocumentCatalog().getNames() == null);
            assertTrue(pdf.getDocumentCatalog().getAcroForm() == null);
            assertTrue(pdf.getPage(0).getAnnotations().isEmpty());
        }
    }

    @Test
    void semanticVerificationFindingBlocksExportBeforeOutputIsPublished() throws Exception {
        Path workspace = tempDir.resolve("semantic-verification");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("semantic-verification").id(),
                        List.of(pdf("source.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        Batch reviewed =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-box-1",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                new ReviewActionState(
                                        "PHONE",
                                        "PATIENT",
                                        new RedactionBox(page.id(), 40, 50, 120, 36),
                                        SelectionState.SELECTED,
                                        SelectionSource.MANUAL_RECTANGLE)));

        Batch blocked =
                service.finalizeDocument(
                        reviewed.id(),
                        document.id(),
                        null,
                        (verifiedDocument, outputPath) ->
                                List.of(
                                        MedicalRedactIssueMapper.issue(
                                                MedicalRedactIssueCode.MR_VERIFY_7004,
                                                "KNOWN_VALUE_SURVIVED")));

        assertEquals(BatchStatus.BLOCKED, blocked.status());
        assertEquals(DocumentStatus.BLOCKED, blocked.documents().getFirst().status());
        var report = blocked.verificationReports().getFirst();
        assertEquals("BLOCKED", report.status());
        assertEquals(1, report.findingCount());
        assertEquals("MR-VERIFY-7004", report.issues().getFirst().code());
        assertTrue(report.outputRelativePath() == null);
        assertThrows(
                IllegalStateException.class, () -> service.openOutput(blocked.id(), document.id()));
    }

    @Test
    void verificationCanBeSkippedWithoutBlockingGeneratedOutput() throws Exception {
        Path workspace = tempDir.resolve("verification-skipped");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("verification-skipped").id(),
                        List.of(pdf("source.pdf", 1)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        Batch reviewed =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-box-1",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                new ReviewActionState(
                                        "PHONE",
                                        "PATIENT",
                                        new RedactionBox(page.id(), 40, 50, 120, 36),
                                        SelectionState.SELECTED,
                                        SelectionSource.MANUAL_RECTANGLE)));

        Batch generated =
                service.finalizeDocument(
                        reviewed.id(),
                        document.id(),
                        null,
                        (verifiedDocument, outputPath) ->
                                List.of(
                                        MedicalRedactIssueMapper.issue(
                                                MedicalRedactIssueCode.MR_VERIFY_7004,
                                                "KNOWN_VALUE_SURVIVED")),
                        false);

        assertEquals(BatchStatus.VERIFIED, generated.status());
        assertEquals(DocumentStatus.VERIFIED, generated.documents().getFirst().status());
        var report = generated.verificationReports().getFirst();
        assertEquals("SKIPPED", report.status());
        assertEquals(0, report.findingCount());
        assertTrue(report.issues().isEmpty());
        assertTrue(report.outputRelativePath() != null);
        assertTrue(Files.isRegularFile(service.openOutput(generated.id(), document.id()).path()));
    }

    @Test
    void imageInputGetsPdfReviewDerivativeWithoutChangingSource() throws Exception {
        Path workspace = tempDir.resolve("workspace");
        MedicalRedactWorkspaceService service =
                new MedicalRedactWorkspaceService(new ObjectMapper(), workspace);
        Batch imported =
                service.importDocuments(
                        service.createBatch("image-review").id(),
                        List.of(png("scan.png", 240, 160)));
        var document = imported.documents().getFirst();
        Path source = workspace.resolve(document.sourceRelativePath());
        String beforeHash = document.sha256();

        var review = service.openReviewPdf(imported.id(), document.id());

        assertTrue(Files.isRegularFile(review.path()));
        assertTrue(review.path().getFileName().toString().endsWith(".pdf"));
        assertFalse(review.path().equals(source));
        assertEquals(beforeHash, service.getBatch(imported.id()).documents().getFirst().sha256());
        try (PDDocument pdf = org.apache.pdfbox.Loader.loadPDF(review.path().toFile())) {
            assertEquals(1, pdf.getNumberOfPages());
            assertEquals(240f, pdf.getPage(0).getMediaBox().getWidth());
            assertEquals(160f, pdf.getPage(0).getMediaBox().getHeight());
        }
        assertSourceReadOnlyWhenPosix(source);
    }

    private void assertDarkPixel(BufferedImage image, int x, int y) {
        Color color = new Color(image.getRGB(x, y));
        assertTrue(
                color.getRed() < 32 && color.getGreen() < 32 && color.getBlue() < 32,
                "Expected dark pixel at (" + x + ", " + y + ") but was " + color);
    }

    private void assertLightPixel(BufferedImage image, int x, int y) {
        Color color = new Color(image.getRGB(x, y));
        assertTrue(
                color.getRed() > 224 && color.getGreen() > 224 && color.getBlue() > 224,
                "Expected light pixel at (" + x + ", " + y + ") but was " + color);
    }

    private MockMultipartFile png(String filename, int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        var graphics = image.createGraphics();
        try {
            graphics.setColor(Color.WHITE);
            graphics.fillRect(0, 0, width, height);
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return new MockMultipartFile("files", filename, "image/png", output.toByteArray());
    }

    private MockMultipartFile pdf(String filename, int pageCount) throws Exception {
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

    private void assertSourceReadOnlyWhenPosix(Path source) throws Exception {
        PosixFileAttributeView view =
                Files.getFileAttributeView(source, PosixFileAttributeView.class);
        if (view == null) {
            return;
        }
        Set<PosixFilePermission> permissions = view.readAttributes().permissions();
        assertFalse(permissions.contains(PosixFilePermission.OWNER_WRITE));
        assertFalse(permissions.contains(PosixFilePermission.GROUP_WRITE));
        assertFalse(permissions.contains(PosixFilePermission.OTHERS_WRITE));
    }
}
