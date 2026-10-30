package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.file.virtualfs.VirtualFileSystemFactory;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import net.lingala.zip4j.ZipFile;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryCredentials;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryManifest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProfile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProtocol;
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

class MedicalRedactDeliverySftpIntegrationTest {

    private static final String USER = "stirling";
    private static final String PASSWORD = "local-sftp-password";
    private static final String ARCHIVE_PASSWORD = "local-archive-password-123";

    @TempDir Path tempDir;

    private SshServer sshd;

    @AfterEach
    void stopServer() throws Exception {
        if (sshd != null) {
            sshd.stop(true);
        }
    }

    @Test
    void secureRasterArchiveUploadsDownloadsDecryptsAndMatchesHashOverRealSftp() throws Exception {
        Path remoteRoot = tempDir.resolve("remote-root");
        Files.createDirectories(remoteRoot.resolve("upload"));

        sshd = SshServer.setUpDefaultServer();
        sshd.setHost("127.0.0.1");
        sshd.setPort(0);
        SimpleGeneratorHostKeyProvider hostKeys =
                new SimpleGeneratorHostKeyProvider(tempDir.resolve("sftp-host-key.ser"));
        hostKeys.setAlgorithm("RSA");
        sshd.setKeyPairProvider(hostKeys);
        sshd.setPasswordAuthenticator(
                (username, password, session) ->
                        USER.equals(username) && PASSWORD.equals(password));
        sshd.setSubsystemFactories(List.of(new SftpSubsystemFactory.Builder().build()));
        sshd.setFileSystemFactory(new VirtualFileSystemFactory(remoteRoot));
        sshd.start();

        KeyPair hostKey = sshd.getKeyPairProvider().loadKeys(null).iterator().next();
        String fingerprint = KeyUtils.getFingerPrint(hostKey.getPublic());
        assertTrue(fingerprint.startsWith("SHA256:"));

        Path workspace = tempDir.resolve("workspace");
        ObjectMapper mapper = new ObjectMapper();
        MedicalRedactWorkspaceService workspaceService =
                new MedicalRedactWorkspaceService(mapper, workspace);
        var batch = generatedBatch(workspaceService);
        var document = batch.documents().getFirst();
        String expectedOutputHash =
                workspaceService.openOutput(batch.id(), document.id()).report().sha256();

        DeliveryProfile profile =
                new DeliveryProfile(
                        "local-sftp",
                        DeliveryProtocol.SFTP,
                        "127.0.0.1",
                        sshd.getPort(),
                        USER,
                        "/upload",
                        "local-sftp",
                        fingerprint,
                        true,
                        null);
        DeliveryCredentials credentials =
                new DeliveryCredentials(PASSWORD, null, null, ARCHIVE_PASSWORD);
        MedicalRedactDeliveryService service =
                new MedicalRedactDeliveryService(
                        mapper,
                        workspaceService,
                        new DefaultMedicalRedactDeliveryClientFactory(),
                        "3.2.1-test");

        assertTrue(service.testConnection(new DeliveryRequest(profile, credentials)).success());
        var delivered = service.deliver(batch.id(), new DeliveryRequest(profile, credentials));

        assertEquals(DeliveryStatus.UPLOADED, delivered.status());
        Path remoteArchive = remoteRoot.resolve("upload").resolve(delivered.archiveFilename());
        assertTrue(Files.isRegularFile(remoteArchive));
        assertFalse(
                Files.exists(
                        remoteRoot
                                .resolve("upload")
                                .resolve(delivered.archiveFilename() + ".uploading")));
        assertEquals(delivered.archiveSha256(), sha256(remoteArchive));

        Path downloaded = tempDir.resolve("downloaded.zip");
        try (MedicalRedactDeliveryClient client =
                        new DefaultMedicalRedactDeliveryClientFactory()
                                .connect(profile, credentials);
                InputStream input = client.open(delivered.remotePath())) {
            Files.copy(input, downloaded);
        }
        assertEquals(delivered.archiveSha256(), sha256(downloaded));

        Path extracted = tempDir.resolve("downloaded-extracted");
        try (ZipFile zip = new ZipFile(downloaded.toFile(), ARCHIVE_PASSWORD.toCharArray())) {
            zip.extractAll(extracted.toString());
        }
        DeliveryManifest manifest =
                mapper.readValue(
                        extracted.resolve("manifest.json").toFile(), DeliveryManifest.class);
        assertEquals("SKIPPED", manifest.files().getFirst().verificationStatus());
        assertEquals(expectedOutputHash, manifest.files().getFirst().sha256());
        assertEquals(expectedOutputHash, sha256(extracted.resolve("DOC0001.pdf")));
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "MEDICAL_REDACT_LIVE_SFTP", matches = "true")
    void secureRasterArchiveRetriesAndVerifiesAgainstConfiguredLiveSftp() throws Exception {
        String host = requiredEnv("MEDICAL_REDACT_LIVE_SFTP_HOST");
        int port = Integer.parseInt(requiredEnv("MEDICAL_REDACT_LIVE_SFTP_PORT"));
        String username = requiredEnv("MEDICAL_REDACT_LIVE_SFTP_USERNAME");
        String password = requiredEnv("MEDICAL_REDACT_LIVE_SFTP_PASSWORD");
        String fingerprint = requiredEnv("MEDICAL_REDACT_LIVE_SFTP_FINGERPRINT");
        String remoteDirectory = requiredEnv("MEDICAL_REDACT_LIVE_SFTP_DIRECTORY");
        String archivePassword = requiredEnv("MEDICAL_REDACT_LIVE_ARCHIVE_PASSWORD");

        Path workspace = tempDir.resolve("live-workspace");
        ObjectMapper mapper = new ObjectMapper();
        MedicalRedactWorkspaceService workspaceService =
                new MedicalRedactWorkspaceService(mapper, workspace);
        var batch = generatedBatch(workspaceService);
        var document = batch.documents().getFirst();
        String expectedOutputHash =
                workspaceService.openOutput(batch.id(), document.id()).report().sha256();

        String profileId = "configured-live-sftp";
        DeliveryProfile goodProfile =
                new DeliveryProfile(
                        profileId,
                        DeliveryProtocol.SFTP,
                        host,
                        port,
                        username,
                        remoteDirectory,
                        profileId,
                        fingerprint,
                        true,
                        null);
        DeliveryProfile nonWritableProfile =
                new DeliveryProfile(
                        profileId,
                        DeliveryProtocol.SFTP,
                        host,
                        port,
                        username,
                        ".",
                        profileId,
                        fingerprint,
                        true,
                        null);
        DeliveryCredentials credentials =
                new DeliveryCredentials(password, null, null, archivePassword);
        MedicalRedactDeliveryService service =
                new MedicalRedactDeliveryService(
                        mapper,
                        workspaceService,
                        new DefaultMedicalRedactDeliveryClientFactory(),
                        "3.2.1-live-test");

        assertTrue(service.testConnection(new DeliveryRequest(goodProfile, credentials)).success());

        MedicalRedactDeliveryException firstFailure =
                assertThrows(
                        MedicalRedactDeliveryException.class,
                        () ->
                                service.deliver(
                                        batch.id(),
                                        new DeliveryRequest(nonWritableProfile, credentials)));
        assertEquals(MedicalRedactIssueCode.MR_DELIVERY_8510, firstFailure.issueCode());
        var failed = service.getDelivery(batch.id());
        assertEquals(DeliveryStatus.UPLOAD_FAILED, failed.status());

        var delivered = service.deliver(batch.id(), new DeliveryRequest(goodProfile, credentials));
        assertEquals(DeliveryStatus.UPLOADED, delivered.status());
        assertEquals(failed.packageId(), delivered.packageId());
        assertEquals(failed.archiveFilename(), delivered.archiveFilename());
        assertEquals("ZIP-AES-256", delivered.encryptionAlgorithm());

        Path downloaded = tempDir.resolve("live-downloaded.zip");
        try (MedicalRedactDeliveryClient client =
                        new DefaultMedicalRedactDeliveryClientFactory()
                                .connect(goodProfile, credentials);
                InputStream input = client.open(delivered.remotePath())) {
            Files.copy(input, downloaded);
            assertThrows(
                    MedicalRedactDeliveryException.class,
                    () -> client.open(delivered.remotePath() + ".uploading"));
        }
        assertEquals(delivered.archiveSha256(), sha256(downloaded));

        Path extracted = tempDir.resolve("live-downloaded-extracted");
        try (ZipFile zip = new ZipFile(downloaded.toFile(), archivePassword.toCharArray())) {
            zip.extractAll(extracted.toString());
        }
        DeliveryManifest manifest =
                mapper.readValue(
                        extracted.resolve("manifest.json").toFile(), DeliveryManifest.class);
        assertEquals("ZIP-AES-256", manifest.encryptionAlgorithm());
        assertEquals("SKIPPED", manifest.files().getFirst().verificationStatus());
        assertEquals(expectedOutputHash, manifest.files().getFirst().sha256());
        assertEquals(expectedOutputHash, sha256(extracted.resolve("DOC0001.pdf")));
    }

    private String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private MedicalRedactModels.Batch generatedBatch(MedicalRedactWorkspaceService service)
            throws Exception {
        var imported =
                service.importDocuments(
                        service.createBatch("本地 SFTP 真实链路").id(), List.of(pdf("患者原始病历.pdf")));
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

    private String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(Files.readAllBytes(path));
        return HexFormat.of().formatHex(digest.digest());
    }
}
