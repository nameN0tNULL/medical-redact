package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.exception.ZipException;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryCredentials;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryManifest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProfile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProtocol;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRecord;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RedactionBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewTargetType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SaveReviewActionRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;

import tools.jackson.databind.ObjectMapper;

class MedicalRedactDeliveryServiceTest {

    private static final String SERVER_PASSWORD = "server-password";
    private static final String ARCHIVE_PASSWORD = "archive-password-123";
    private static final String ORIGINAL_FILENAME = "患者张三原始病历.pdf";

    @TempDir Path tempDir;

    @Test
    void encryptedArchiveContainsOnlyRedactedOutputsAndManifest() throws Exception {
        TestContext context = context(false);
        var batch = generatedBatch(context.workspaceService());
        DeliveryRecord delivered = context.deliveryService().deliver(batch.id(), request());

        assertEquals(DeliveryStatus.UPLOADED, delivered.status());
        assertEquals("ZIP-AES-256", delivered.encryptionAlgorithm());
        assertEquals(1, delivered.documentCount());
        assertTrue(delivered.archiveFilename().startsWith("PKG-"));
        assertFalse(delivered.archiveFilename().contains("张三"));
        assertFalse(delivered.archiveFilename().contains("病历"));

        Path archive = tempDir.resolve("workspace").resolve(delivered.archiveRelativePath());
        assertTrue(Files.isRegularFile(archive));
        assertEquals(sha256(archive), delivered.archiveSha256());

        ZipFile encrypted = new ZipFile(archive.toFile());
        assertTrue(encrypted.isEncrypted());
        assertThrows(
                ZipException.class,
                () -> encrypted.extractAll(tempDir.resolve("without-password").toString()));

        Path extracted = tempDir.resolve("extracted");
        try (ZipFile zip = new ZipFile(archive.toFile(), ARCHIVE_PASSWORD.toCharArray())) {
            zip.extractAll(extracted.toString());
        }

        List<String> entries;
        try (var stream = Files.list(extracted)) {
            entries = stream.map(path -> path.getFileName().toString()).sorted().toList();
        }
        assertEquals(List.of("DOC0001.pdf", "manifest.json"), entries);

        String manifestJson = Files.readString(extracted.resolve("manifest.json"));
        assertFalse(manifestJson.contains(ORIGINAL_FILENAME));
        assertFalse(manifestJson.contains("张三"));
        assertFalse(manifestJson.contains(SERVER_PASSWORD));
        assertFalse(manifestJson.contains(ARCHIVE_PASSWORD));

        DeliveryManifest manifest =
                new ObjectMapper()
                        .readValue(
                                extracted.resolve("manifest.json").toFile(),
                                DeliveryManifest.class);
        assertEquals(1, manifest.schemaVersion());
        assertEquals(batch.id(), manifest.batchId());
        assertEquals("3.2.1-test", manifest.appVersion());
        assertEquals(1, manifest.documentCount());
        assertEquals("DOC0001.pdf", manifest.files().getFirst().internalFilename());
        assertEquals("SKIPPED", manifest.files().getFirst().verificationStatus());
        assertEquals(
                sha256(extracted.resolve("DOC0001.pdf")), manifest.files().getFirst().sha256());
        assertEquals(64, manifest.packageSha256().length());

        String stateJson =
                Files.readString(
                        tempDir.resolve("workspace")
                                .resolve("delivery/state")
                                .resolve(batch.id() + ".json"));
        assertFalse(stateJson.contains(SERVER_PASSWORD));
        assertFalse(stateJson.contains(ARCHIVE_PASSWORD));
        assertFalse(stateJson.contains(ORIGINAL_FILENAME));
    }

    @Test
    void failedPartialUploadKeepsPackageAndRetryReusesIt() throws Exception {
        TestContext context = context(true);
        var batch = generatedBatch(context.workspaceService());

        MedicalRedactDeliveryException failed =
                assertThrows(
                        MedicalRedactDeliveryException.class,
                        () -> context.deliveryService().deliver(batch.id(), request()));
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8511, failed.issueCode());

        DeliveryRecord failure = context.deliveryService().getDelivery(batch.id());
        assertEquals(DeliveryStatus.UPLOAD_FAILED, failure.status());
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8511.code(), failure.lastErrorCode());
        Path archive = tempDir.resolve("workspace").resolve(failure.archiveRelativePath());
        assertTrue(Files.isRegularFile(archive));
        assertTrue(
                context.remote().paths.keySet().stream()
                        .allMatch(path -> path.endsWith(".uploading")));

        context.remote().failNextUpload = false;
        DeliveryRecord retried = context.deliveryService().deliver(batch.id(), request());

        assertEquals(DeliveryStatus.UPLOADED, retried.status());
        assertEquals(failure.packageId(), retried.packageId());
        assertEquals(failure.archiveSha256(), retried.archiveSha256());
        assertEquals(1, context.remote().renameCount);
        assertTrue(context.remote().paths.containsKey(retried.remotePath()));
        assertFalse(context.remote().paths.containsKey(retried.remotePath() + ".uploading"));

        MedicalRedactDeliveryService restarted =
                new MedicalRedactDeliveryService(
                        new ObjectMapper(),
                        context.workspaceService(),
                        context.factory(),
                        "3.2.1-test");
        assertEquals(DeliveryStatus.UPLOADED, restarted.getDelivery(batch.id()).status());
    }

    @Test
    void interruptedUploadingStateBecomesRetryableFailureAfterRestart() throws Exception {
        TestContext context = context(false);
        var batch = generatedBatch(context.workspaceService());
        DeliveryRecord delivered = context.deliveryService().deliver(batch.id(), request());

        Path state =
                tempDir.resolve("workspace")
                        .resolve("delivery/state")
                        .resolve(batch.id() + ".json");
        ObjectMapper mapper = new ObjectMapper();
        DeliveryRecord uploading =
                new DeliveryRecord(
                        delivered.batchId(),
                        DeliveryStatus.UPLOADING,
                        delivered.packageId(),
                        delivered.profileId(),
                        delivered.archiveFilename(),
                        delivered.archiveRelativePath(),
                        delivered.packageSha256(),
                        delivered.archiveSha256(),
                        delivered.encryptionAlgorithm(),
                        delivered.documentCount(),
                        null,
                        delivered.createdAt(),
                        null,
                        null);
        mapper.writerWithDefaultPrettyPrinter().writeValue(state.toFile(), uploading);

        MedicalRedactDeliveryService restarted =
                new MedicalRedactDeliveryService(
                        mapper, context.workspaceService(), context.factory(), "3.2.1-test");
        DeliveryRecord recovered = restarted.getDelivery(batch.id());

        assertEquals(DeliveryStatus.UPLOAD_FAILED, recovered.status());
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8511.code(), recovered.lastErrorCode());
    }

    @Test
    void sftpRequiresPinnedHostKeyAndArchivePasswordIsRequiredOnlyForDelivery() throws Exception {
        TestContext context = context(false);
        DeliveryProfile withoutFingerprint =
                new DeliveryProfile(
                        "default",
                        DeliveryProtocol.SFTP,
                        "localhost",
                        22,
                        "stirling",
                        "upload",
                        "default",
                        null,
                        true,
                        null);
        DeliveryRequest connectionRequest = new DeliveryRequest(withoutFingerprint, credentials());

        MedicalRedactDeliveryException invalid =
                assertThrows(
                        MedicalRedactDeliveryException.class,
                        () -> context.deliveryService().testConnection(connectionRequest));
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8501, invalid.issueCode());

        DeliveryCredentials noArchivePassword =
                new DeliveryCredentials(SERVER_PASSWORD, null, null, null);
        DeliveryRequest validConnectionOnly = new DeliveryRequest(profile(), noArchivePassword);
        assertTrue(context.deliveryService().testConnection(validConnectionOnly).success());

        var batch = generatedBatch(context.workspaceService());
        MedicalRedactDeliveryException missingArchivePassword =
                assertThrows(
                        MedicalRedactDeliveryException.class,
                        () -> context.deliveryService().deliver(batch.id(), validConnectionOnly));
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8501, missingArchivePassword.issueCode());
    }

    private TestContext context(boolean failNextUpload) throws Exception {
        Path workspace = tempDir.resolve("workspace");
        ObjectMapper mapper = new ObjectMapper();
        MedicalRedactWorkspaceService workspaceService =
                new MedicalRedactWorkspaceService(mapper, workspace);
        FakeRemote remote = new FakeRemote();
        remote.failNextUpload = failNextUpload;
        FakeFactory factory = new FakeFactory(remote);
        MedicalRedactDeliveryService deliveryService =
                new MedicalRedactDeliveryService(mapper, workspaceService, factory, "3.2.1-test");
        return new TestContext(workspaceService, deliveryService, factory, remote);
    }

    private MedicalRedactModels.Batch generatedBatch(MedicalRedactWorkspaceService service)
            throws Exception {
        var imported =
                service.importDocuments(
                        service.createBatch("测试任务").id(), List.of(pdf(ORIGINAL_FILENAME)));
        var document = imported.documents().getFirst();
        var page = document.pages().getFirst();
        var reviewed =
                service.saveReviewAction(
                        imported.id(),
                        new SaveReviewActionRequest(
                                document.id(),
                                ReviewTargetType.MANUAL_RECTANGLE,
                                "manual-box",
                                ReviewActionType.ADD_MANUAL,
                                null,
                                new ReviewActionState(
                                        "PATIENT_NAME",
                                        "PATIENT",
                                        new RedactionBox(page.id(), 30, 40, 100, 30),
                                        SelectionState.SELECTED,
                                        SelectionSource.MANUAL_RECTANGLE)));
        return service.finalizeDocument(
                reviewed.id(),
                document.id(),
                null,
                (verifiedDocument, outputPath) -> List.of(),
                false);
    }

    private MockMultipartFile pdf(String filename) throws Exception {
        try (PDDocument document = new PDDocument();
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            document.addPage(new PDPage(PDRectangle.A4));
            document.save(output);
            return new MockMultipartFile(
                    "files", filename, "application/pdf", output.toByteArray());
        }
    }

    private DeliveryRequest request() {
        return new DeliveryRequest(profile(), credentials());
    }

    private DeliveryProfile profile() {
        return new DeliveryProfile(
                "default",
                DeliveryProtocol.SFTP,
                "localhost",
                22,
                "stirling",
                "upload",
                "default",
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                true,
                null);
    }

    private DeliveryCredentials credentials() {
        return new DeliveryCredentials(SERVER_PASSWORD, null, null, ARCHIVE_PASSWORD);
    }

    private String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(Files.readAllBytes(path));
        return HexFormat.of().formatHex(digest.digest());
    }

    private record TestContext(
            MedicalRedactWorkspaceService workspaceService,
            MedicalRedactDeliveryService deliveryService,
            FakeFactory factory,
            FakeRemote remote) {}

    private static final class FakeFactory implements MedicalRedactDeliveryClientFactory {

        private final FakeRemote remote;

        private FakeFactory(FakeRemote remote) {
            this.remote = remote;
        }

        @Override
        public MedicalRedactDeliveryClient connect(
                DeliveryProfile profile, DeliveryCredentials credentials) {
            assertNotEquals("", profile.sftpHostKeyFingerprint());
            return new FakeClient(remote);
        }
    }

    private static final class FakeRemote {

        private final Map<String, byte[]> paths = new HashMap<>();
        private boolean failNextUpload;
        private int renameCount;
    }

    private static final class FakeClient implements MedicalRedactDeliveryClient {

        private final FakeRemote remote;

        private FakeClient(FakeRemote remote) {
            this.remote = remote;
        }

        @Override
        public void verifyWritableDirectory() {}

        @Override
        public void upload(Path localFile, String remotePath) {
            try {
                byte[] bytes = Files.readAllBytes(localFile);
                if (remote.failNextUpload) {
                    remote.paths.put(
                            remotePath, Arrays.copyOf(bytes, Math.max(1, bytes.length / 2)));
                    remote.failNextUpload = false;
                    throw new MedicalRedactDeliveryException(
                            MedicalRedactIssueCode.MR_DELIVERY_8511, "simulated partial upload");
                }
                remote.paths.put(remotePath, bytes);
            } catch (MedicalRedactDeliveryException e) {
                throw e;
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        }

        @Override
        public InputStream open(String remotePath) {
            byte[] bytes = remote.paths.get(remotePath);
            if (bytes == null) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8513, "missing remote path");
            }
            return new ByteArrayInputStream(bytes);
        }

        @Override
        public void rename(String source, String target) {
            byte[] bytes = remote.paths.remove(source);
            if (bytes == null) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8512, "missing temp path");
            }
            remote.paths.put(target, bytes);
            remote.renameCount++;
        }

        @Override
        public void delete(String remotePath) {
            remote.paths.remove(remotePath);
        }

        @Override
        public void close() {}
    }
}
