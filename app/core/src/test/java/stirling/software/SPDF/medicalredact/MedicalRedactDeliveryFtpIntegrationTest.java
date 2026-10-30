package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.HexFormat;
import java.util.List;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

import org.apache.ftpserver.FtpServer;
import org.apache.ftpserver.FtpServerFactory;
import org.apache.ftpserver.ftplet.Authority;
import org.apache.ftpserver.listener.ListenerFactory;
import org.apache.ftpserver.ssl.SslConfigurationFactory;
import org.apache.ftpserver.usermanager.impl.BaseUser;
import org.apache.ftpserver.usermanager.impl.WritePermission;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryCredentials;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProfile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProtocol;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.FtpsMode;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RedactionBox;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionState;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewActionType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.ReviewTargetType;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SaveReviewActionRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionSource;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.SelectionState;

import tools.jackson.databind.ObjectMapper;

class MedicalRedactDeliveryFtpIntegrationTest {

    private static final String USER = "delivery";
    private static final String PASSWORD = "local-ftp-password";
    private static final String ARCHIVE_PASSWORD = "local-archive-password-123";
    private static final char[] KEYSTORE_PASSWORD = "changeit".toCharArray();

    @TempDir Path tempDir;

    private FtpServer ftpServer;
    private SSLContext previousDefaultSslContext;
    private String previousTrustStore;
    private String previousTrustStorePassword;

    @AfterEach
    void tearDown() {
        if (ftpServer != null && !ftpServer.isStopped()) {
            ftpServer.stop();
        }
        if (previousDefaultSslContext != null) {
            SSLContext.setDefault(previousDefaultSslContext);
        }
        restoreSystemProperty("javax.net.ssl.trustStore", previousTrustStore);
        restoreSystemProperty("javax.net.ssl.trustStorePassword", previousTrustStorePassword);
    }

    @Test
    void ftpUploadsViaTemporaryNameThenPublishesFinalArchive() throws Exception {
        ProtocolServer server = startServer(false, false);
        DeliveryProfile profile = profile(DeliveryProtocol.FTP, server.port(), null);

        DeliveredFixture delivered = deliver(profile);

        assertRemoteArchive(delivered, server.remoteRoot());
    }

    @Test
    void explicitFtpsUploadsWithValidatedTlsCertificate() throws Exception {
        ProtocolServer server = startServer(true, false);
        DeliveryProfile profile = profile(DeliveryProtocol.FTPS, server.port(), FtpsMode.EXPLICIT);

        DeliveredFixture delivered = deliver(profile);

        assertRemoteArchive(delivered, server.remoteRoot());
    }

    @Test
    void implicitFtpsUploadsWithValidatedTlsCertificate() throws Exception {
        ProtocolServer server = startServer(true, true);
        DeliveryProfile profile = profile(DeliveryProtocol.FTPS, server.port(), FtpsMode.IMPLICIT);

        DeliveredFixture delivered = deliver(profile);

        assertRemoteArchive(delivered, server.remoteRoot());
    }

    private ProtocolServer startServer(boolean tls, boolean implicit) throws Exception {
        Path remoteRoot =
                tempDir.resolve(tls ? (implicit ? "ftps-implicit" : "ftps-explicit") : "ftp");
        Files.createDirectories(remoteRoot.resolve("upload"));
        int port = freePort();

        FtpServerFactory serverFactory = new FtpServerFactory();
        BaseUser user = new BaseUser();
        user.setName(USER);
        user.setPassword(PASSWORD);
        user.setHomeDirectory(remoteRoot.toAbsolutePath().toString());
        user.setAuthorities(List.<Authority>of(new WritePermission()));
        serverFactory.getUserManager().save(user);

        ListenerFactory listenerFactory = new ListenerFactory();
        listenerFactory.setPort(port);
        if (tls) {
            TlsMaterial tlsMaterial = createTlsMaterial();
            SslConfigurationFactory sslFactory = new SslConfigurationFactory();
            sslFactory.setKeystoreFile(tlsMaterial.keyStore().toFile());
            sslFactory.setKeystorePassword(new String(KEYSTORE_PASSWORD));
            listenerFactory.setSslConfiguration(sslFactory.createSslConfiguration());
            listenerFactory.setImplicitSsl(implicit);
            installTestTrustStore(tlsMaterial.trustStore());
        }
        serverFactory.addListener("default", listenerFactory.createListener());
        ftpServer = serverFactory.createServer();
        ftpServer.start();
        return new ProtocolServer(port, remoteRoot);
    }

    private DeliveredFixture deliver(DeliveryProfile profile) throws Exception {
        Path workspace =
                tempDir.resolve("workspace-" + profile.protocol() + "-" + profile.ftpsMode());
        ObjectMapper mapper = new ObjectMapper();
        MedicalRedactWorkspaceService workspaceService =
                new MedicalRedactWorkspaceService(mapper, workspace);
        var batch = generatedBatch(workspaceService);
        var document = batch.documents().getFirst();
        String expectedOutputHash =
                workspaceService.openOutput(batch.id(), document.id()).report().sha256();

        DeliveryCredentials credentials =
                new DeliveryCredentials(PASSWORD, null, null, ARCHIVE_PASSWORD);
        MedicalRedactDeliveryService service =
                new MedicalRedactDeliveryService(
                        mapper,
                        workspaceService,
                        new DefaultMedicalRedactDeliveryClientFactory(),
                        "3.2.1-test");

        assertTrue(service.testConnection(new DeliveryRequest(profile, credentials)).success());
        var record = service.deliver(batch.id(), new DeliveryRequest(profile, credentials));
        assertEquals(DeliveryStatus.UPLOADED, record.status());
        return new DeliveredFixture(record, expectedOutputHash);
    }

    private void assertRemoteArchive(DeliveredFixture delivered, Path remoteRoot) throws Exception {
        Path finalArchive =
                remoteRoot.resolve("upload").resolve(delivered.record().archiveFilename());
        Path temporaryArchive =
                remoteRoot
                        .resolve("upload")
                        .resolve(delivered.record().archiveFilename() + ".uploading");

        assertTrue(Files.isRegularFile(finalArchive));
        assertFalse(Files.exists(temporaryArchive));
        assertEquals(delivered.record().archiveSha256(), sha256(finalArchive));

        Path extracted = tempDir.resolve("extract-" + delivered.record().packageId());
        try (var zip =
                new net.lingala.zip4j.ZipFile(
                        finalArchive.toFile(), ARCHIVE_PASSWORD.toCharArray())) {
            zip.extractAll(extracted.toString());
        }
        assertEquals(delivered.expectedOutputHash(), sha256(extracted.resolve("DOC0001.pdf")));
    }

    private DeliveryProfile profile(DeliveryProtocol protocol, int port, FtpsMode ftpsMode) {
        return new DeliveryProfile(
                "local-" + protocol.name().toLowerCase(),
                protocol,
                "localhost",
                port,
                USER,
                "upload",
                "local-" + protocol.name().toLowerCase(),
                null,
                true,
                ftpsMode);
    }

    private MedicalRedactModels.Batch generatedBatch(MedicalRedactWorkspaceService service)
            throws Exception {
        var imported =
                service.importDocuments(
                        service.createBatch("本地 FTP(S) 真实链路").id(), List.of(pdf("患者原始病历.pdf")));
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

    private TlsMaterial createTlsMaterial() throws Exception {
        KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
        keyPairGenerator.initialize(2048);
        KeyPair keyPair = keyPairGenerator.generateKeyPair();

        Instant now = Instant.now();
        X500Name subject = new X500Name("CN=localhost");
        JcaX509v3CertificateBuilder certificateBuilder =
                new JcaX509v3CertificateBuilder(
                        subject,
                        new BigInteger(96, new SecureRandom()),
                        Date.from(now.minus(1, ChronoUnit.DAYS)),
                        Date.from(now.plus(7, ChronoUnit.DAYS)),
                        subject,
                        keyPair.getPublic());
        certificateBuilder.addExtension(
                Extension.subjectAlternativeName,
                false,
                new GeneralNames(new GeneralName(GeneralName.dNSName, "localhost")));
        X509Certificate certificate =
                new JcaX509CertificateConverter()
                        .getCertificate(
                                certificateBuilder.build(
                                        new JcaContentSignerBuilder("SHA256withRSA")
                                                .build(keyPair.getPrivate())));
        certificate.verify(keyPair.getPublic());

        Path keyStorePath = tempDir.resolve("ftp-server.jks");
        KeyStore keyStore = KeyStore.getInstance("JKS");
        keyStore.load(null, KEYSTORE_PASSWORD);
        keyStore.setKeyEntry(
                "server", keyPair.getPrivate(), KEYSTORE_PASSWORD, new Certificate[] {certificate});
        try (var output = Files.newOutputStream(keyStorePath)) {
            keyStore.store(output, KEYSTORE_PASSWORD);
        }

        Path trustStorePath = tempDir.resolve("ftp-trust.jks");
        KeyStore trustStore = KeyStore.getInstance("JKS");
        trustStore.load(null, KEYSTORE_PASSWORD);
        trustStore.setCertificateEntry("server", certificate);
        try (var output = Files.newOutputStream(trustStorePath)) {
            trustStore.store(output, KEYSTORE_PASSWORD);
        }
        return new TlsMaterial(keyStorePath, trustStorePath);
    }

    private void installTestTrustStore(Path trustStorePath) throws Exception {
        previousDefaultSslContext = SSLContext.getDefault();
        previousTrustStore = System.getProperty("javax.net.ssl.trustStore");
        previousTrustStorePassword = System.getProperty("javax.net.ssl.trustStorePassword");

        System.setProperty("javax.net.ssl.trustStore", trustStorePath.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", new String(KEYSTORE_PASSWORD));

        KeyStore trustStore = KeyStore.getInstance("JKS");
        try (var input = Files.newInputStream(trustStorePath)) {
            trustStore.load(input, KEYSTORE_PASSWORD);
        }
        TrustManagerFactory trustManagerFactory =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trustManagerFactory.init(trustStore);
        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, trustManagerFactory.getTrustManagers(), new SecureRandom());
        SSLContext.setDefault(sslContext);
    }

    private int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(Files.readAllBytes(path));
        return HexFormat.of().formatHex(digest.digest());
    }

    private void restoreSystemProperty(String key, String previous) {
        if (previous == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, previous);
        }
    }

    private record ProtocolServer(int port, Path remoteRoot) {}

    private record TlsMaterial(Path keyStore, Path trustStore) {}

    private record DeliveredFixture(
            MedicalRedactDeliveryModels.DeliveryRecord record, String expectedOutputHash) {}
}
