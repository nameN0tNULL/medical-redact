package stirling.software.SPDF.medicalredact;

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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.model.ZipParameters;
import net.lingala.zip4j.model.enums.AesKeyStrength;
import net.lingala.zip4j.model.enums.EncryptionMethod;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryConnectionTestResult;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryCredentials;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryManifest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryManifestFile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProfile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProtocol;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRecord;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryRequest;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryStatus;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.Batch;
import stirling.software.SPDF.medicalredact.MedicalRedactWorkspaceService.OutputFile;

import tools.jackson.databind.ObjectMapper;

@Service
public class MedicalRedactDeliveryService {

    static final String ENCRYPTION_ALGORITHM = "ZIP-AES-256";
    private static final int MANIFEST_SCHEMA_VERSION = 1;
    private static final Set<DeliveryStatus> RETRYABLE_PACKAGE_STATES =
            Set.of(DeliveryStatus.PACKAGED, DeliveryStatus.UPLOADING, DeliveryStatus.UPLOAD_FAILED);

    private final ObjectMapper objectMapper;
    private final MedicalRedactWorkspaceService workspaceService;
    private final MedicalRedactDeliveryClientFactory clientFactory;
    private final String appVersion;
    private final Path workspaceRoot;
    private final Path deliveryRoot;
    private final Path packageRoot;
    private final Path stateRoot;
    private final Path tempRoot;

    @Autowired
    public MedicalRedactDeliveryService(
            ObjectMapper objectMapper,
            MedicalRedactWorkspaceService workspaceService,
            @Qualifier("appVersion") String appVersion)
            throws IOException {
        this(
                objectMapper,
                workspaceService,
                new DefaultMedicalRedactDeliveryClientFactory(),
                appVersion);
    }

    MedicalRedactDeliveryService(
            ObjectMapper objectMapper,
            MedicalRedactWorkspaceService workspaceService,
            MedicalRedactDeliveryClientFactory clientFactory,
            String appVersion)
            throws IOException {
        this.objectMapper = objectMapper;
        this.workspaceService = workspaceService;
        this.clientFactory = clientFactory;
        this.appVersion = appVersion == null || appVersion.isBlank() ? "development" : appVersion;
        this.workspaceRoot = workspaceService.internalWorkspaceRoot();
        this.deliveryRoot = workspaceRoot.resolve("delivery");
        this.packageRoot = deliveryRoot.resolve("packages");
        this.stateRoot = deliveryRoot.resolve("state");
        this.tempRoot = deliveryRoot.resolve("temp");
        Files.createDirectories(packageRoot);
        Files.createDirectories(stateRoot);
        Files.createDirectories(tempRoot);
    }

    public DeliveryConnectionTestResult testConnection(DeliveryRequest request) {
        ValidatedDelivery validated = validateRequest(request, false);
        try (MedicalRedactDeliveryClient client =
                clientFactory.connect(validated.profile(), validated.credentials())) {
            client.verifyWritableDirectory();
            return new DeliveryConnectionTestResult(true);
        }
    }

    public synchronized DeliveryRecord getDelivery(String batchId) throws IOException {
        Batch batch = workspaceService.getBatch(batchId);
        Path state = stateFile(batch.id());
        if (!Files.isRegularFile(state)) {
            return emptyRecord(batch.id());
        }
        DeliveryRecord record = objectMapper.readValue(state.toFile(), DeliveryRecord.class);
        if (record.status() == DeliveryStatus.UPLOADING) {
            DeliveryRecord interrupted =
                    withStatus(
                            record,
                            DeliveryStatus.UPLOAD_FAILED,
                            null,
                            null,
                            MedicalRedactIssueCode.MR_DELIVERY_8511.code());
            persistRecord(interrupted);
            return interrupted;
        }
        return record;
    }

    public synchronized DeliveryRecord deliver(String batchId, DeliveryRequest request)
            throws IOException {
        ValidatedDelivery validated = validateRequest(request, true);
        Batch batch = workspaceService.getBatch(batchId);
        PreparedPackage prepared = reusablePackage(batch, validated.profile());
        if (prepared == null) {
            prepared = createPackage(batch, validated.profile(), validated.credentials());
        }

        DeliveryRecord uploading =
                withStatus(prepared.record(), DeliveryStatus.UPLOADING, null, null, null);
        persistRecord(uploading);

        String finalRemotePath =
                MedicalRedactDeliveryPaths.join(
                        validated.profile().remoteDirectory(), uploading.archiveFilename());
        String temporaryRemotePath = finalRemotePath + ".uploading";

        try (MedicalRedactDeliveryClient client =
                clientFactory.connect(validated.profile(), validated.credentials())) {
            client.verifyWritableDirectory();
            client.delete(temporaryRemotePath);
            client.upload(prepared.archivePath(), temporaryRemotePath);
            String remoteHash;
            try (InputStream input = client.open(temporaryRemotePath)) {
                remoteHash = sha256(input);
            }
            if (!uploading.archiveSha256().equals(remoteHash)) {
                client.delete(temporaryRemotePath);
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8513,
                        "Remote archive hash does not match local archive");
            }
            client.rename(temporaryRemotePath, finalRemotePath);
            DeliveryRecord completed =
                    withStatus(
                            uploading,
                            DeliveryStatus.UPLOADED,
                            finalRemotePath,
                            Instant.now().toString(),
                            null);
            persistRecord(completed);
            return completed;
        } catch (MedicalRedactDeliveryException e) {
            DeliveryRecord failed =
                    withStatus(
                            uploading,
                            DeliveryStatus.UPLOAD_FAILED,
                            null,
                            null,
                            e.issueCode().code());
            persistRecord(failed);
            throw e;
        } catch (RuntimeException e) {
            DeliveryRecord failed =
                    withStatus(
                            uploading,
                            DeliveryStatus.UPLOAD_FAILED,
                            null,
                            null,
                            MedicalRedactIssueCode.MR_DELIVERY_8599.code());
            persistRecord(failed);
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8599, "Unexpected delivery failure", e);
        }
    }

    private PreparedPackage reusablePackage(Batch batch, DeliveryProfile profile)
            throws IOException {
        Path state = stateFile(batch.id());
        if (!Files.isRegularFile(state)) {
            return null;
        }
        DeliveryRecord record = objectMapper.readValue(state.toFile(), DeliveryRecord.class);
        if (!RETRYABLE_PACKAGE_STATES.contains(record.status())
                || !profile.profileId().equals(record.profileId())
                || record.archiveRelativePath() == null
                || record.archiveSha256() == null) {
            return null;
        }
        Path archive = workspaceRoot.resolve(record.archiveRelativePath()).normalize();
        if (!archive.startsWith(packageRoot)
                || !Files.isRegularFile(archive)
                || !record.archiveSha256().equals(sha256(archive))) {
            return null;
        }
        return new PreparedPackage(record, archive);
    }

    private PreparedPackage createPackage(
            Batch batch, DeliveryProfile profile, DeliveryCredentials credentials)
            throws IOException {
        List<DeliverySource> sources = collectDeliverySources(batch);
        String packageId = UUID.randomUUID().toString();
        String compactId = packageId.replace("-", "").toUpperCase(Locale.ROOT);
        String archiveFilename = "PKG-" + compactId.substring(0, 20) + ".zip";
        Path batchPackageDir = packageRoot.resolve(batch.id());
        Files.createDirectories(batchPackageDir);
        Path archive = batchPackageDir.resolve(archiveFilename);
        Path temporaryArchive =
                tempRoot.resolve(batch.id() + "-" + packageId.replace("-", "") + ".zip.tmp");
        Path temporaryManifest =
                tempRoot.resolve(batch.id() + "-" + packageId.replace("-", "") + "-manifest.json");

        List<DeliveryManifestFile> manifestFiles =
                sources.stream()
                        .map(
                                source ->
                                        new DeliveryManifestFile(
                                                source.internalFilename(),
                                                source.output().report().sha256(),
                                                source.output().report().fileSize(),
                                                source.output().report().pageCount(),
                                                source.output().report().status()))
                        .toList();
        String packageSha256 = logicalPackageSha256(manifestFiles);
        DeliveryManifest manifest =
                new DeliveryManifest(
                        MANIFEST_SCHEMA_VERSION,
                        packageId,
                        batch.id(),
                        Instant.now().toString(),
                        appVersion,
                        manifestFiles.size(),
                        manifestFiles,
                        packageSha256,
                        ENCRYPTION_ALGORITHM,
                        profile.profileId());

        try {
            objectMapper
                    .writerWithDefaultPrettyPrinter()
                    .writeValue(temporaryManifest.toFile(), manifest);
        } catch (RuntimeException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8503,
                    "Unable to write delivery manifest",
                    e);
        }

        try {
            Files.deleteIfExists(temporaryArchive);
            try (ZipFile zipFile =
                    new ZipFile(
                            temporaryArchive.toFile(),
                            credentials.archivePassword().toCharArray())) {
                for (DeliverySource source : sources) {
                    zipFile.addFile(
                            source.output().path().toFile(),
                            encryptedParameters(source.internalFilename()));
                }
                zipFile.addFile(temporaryManifest.toFile(), encryptedParameters("manifest.json"));
            }
            moveAtomically(temporaryArchive, archive);
            restrictToOwner(archive);
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(temporaryArchive);
            if (e instanceof MedicalRedactDeliveryException deliveryException) {
                throw deliveryException;
            }
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8504,
                    "Unable to create encrypted delivery archive",
                    e);
        } finally {
            Files.deleteIfExists(temporaryManifest);
        }

        String archiveHash = sha256(archive);
        DeliveryRecord record =
                new DeliveryRecord(
                        batch.id(),
                        DeliveryStatus.PACKAGED,
                        packageId,
                        profile.profileId(),
                        archiveFilename,
                        workspaceRoot.relativize(archive).toString(),
                        packageSha256,
                        archiveHash,
                        ENCRYPTION_ALGORITHM,
                        manifestFiles.size(),
                        null,
                        manifest.createdAt(),
                        null,
                        null);
        persistRecord(record);
        return new PreparedPackage(record, archive);
    }

    private List<DeliverySource> collectDeliverySources(Batch batch) throws IOException {
        if (batch.documents().isEmpty()) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8503,
                    "Delivery requires at least one redacted output");
        }
        List<DeliverySource> sources = new ArrayList<>();
        int index = 1;
        for (var document : batch.documents()) {
            OutputFile output;
            try {
                output = workspaceService.openOutput(batch.id(), document.id());
            } catch (IllegalStateException | java.util.NoSuchElementException e) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8503,
                        "Every document must have a generated redacted output",
                        e);
            }
            String status = output.report().status();
            if (!"PASS".equals(status) && !"SKIPPED".equals(status)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8503,
                        "Only PASS or SKIPPED outputs may be delivered");
            }
            sources.add(
                    new DeliverySource(String.format(Locale.ROOT, "DOC%04d.pdf", index++), output));
        }
        return List.copyOf(sources);
    }

    private String logicalPackageSha256(List<DeliveryManifestFile> files) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            files.stream()
                    .sorted(Comparator.comparing(DeliveryManifestFile::internalFilename))
                    .forEach(
                            file -> {
                                String canonical =
                                        file.internalFilename()
                                                + "\n"
                                                + file.sha256()
                                                + "\n"
                                                + file.fileSize()
                                                + "\n"
                                                + file.pageCount()
                                                + "\n"
                                                + file.verificationStatus()
                                                + "\n";
                                digest.update(canonical.getBytes(StandardCharsets.UTF_8));
                            });
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_RUNTIME_9007, "SHA-256 is unavailable", e);
        }
    }

    private ZipParameters encryptedParameters(String filename) {
        ZipParameters parameters = new ZipParameters();
        parameters.setEncryptFiles(true);
        parameters.setEncryptionMethod(EncryptionMethod.AES);
        parameters.setAesKeyStrength(AesKeyStrength.KEY_STRENGTH_256);
        parameters.setFileNameInZip(filename);
        return parameters;
    }

    private ValidatedDelivery validateRequest(
            DeliveryRequest request, boolean requireArchivePassword) {
        if (request == null || request.profile() == null || request.credentials() == null) {
            throw invalidConfig("Delivery profile and credentials are required");
        }
        DeliveryProfile profile = request.profile();
        DeliveryCredentials credentials = request.credentials();
        if (profile.profileId() == null
                || !profile.profileId().matches("[A-Za-z0-9._-]{1,64}")
                || profile.credentialRef() == null
                || !profile.profileId().equals(profile.credentialRef())
                || profile.protocol() == null
                || profile.host() == null
                || profile.host().isBlank()
                || profile.username() == null
                || profile.username().isBlank()
                || profile.port() < 1
                || profile.port() > 65535) {
            throw invalidConfig("Delivery profile is incomplete");
        }
        MedicalRedactDeliveryPaths.directory(profile.remoteDirectory());
        if (profile.protocol() == DeliveryProtocol.SFTP) {
            boolean hasPassword =
                    credentials.password() != null && !credentials.password().isBlank();
            boolean hasPrivateKey =
                    credentials.privateKey() != null && !credentials.privateKey().isBlank();
            if ((!hasPassword && !hasPrivateKey)
                    || profile.sftpHostKeyFingerprint() == null
                    || !profile.sftpHostKeyFingerprint()
                            .trim()
                            .matches("^SHA256:[A-Za-z0-9+/]{43}=?$")) {
                throw invalidConfig(
                        "SFTP requires a password or private key and a SHA256 host key fingerprint");
            }
        } else if (credentials.password() == null || credentials.password().isBlank()) {
            throw invalidConfig("FTP and FTPS require a password");
        }
        if (profile.protocol() == DeliveryProtocol.FTPS && profile.ftpsMode() == null) {
            throw invalidConfig("FTPS mode is required");
        }
        if (requireArchivePassword
                && (credentials.archivePassword() == null
                        || credentials.archivePassword().length() < 12)) {
            throw invalidConfig("Archive password must be at least 12 characters");
        }
        return new ValidatedDelivery(profile, credentials);
    }

    private MedicalRedactDeliveryException invalidConfig(String message) {
        return new MedicalRedactDeliveryException(MedicalRedactIssueCode.MR_DELIVERY_8501, message);
    }

    private DeliveryRecord emptyRecord(String batchId) {
        return new DeliveryRecord(
                batchId,
                DeliveryStatus.NOT_DELIVERED,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                0,
                null,
                null,
                null,
                null);
    }

    private DeliveryRecord withStatus(
            DeliveryRecord current,
            DeliveryStatus status,
            String remotePath,
            String completedAt,
            String lastErrorCode) {
        return new DeliveryRecord(
                current.batchId(),
                status,
                current.packageId(),
                current.profileId(),
                current.archiveFilename(),
                current.archiveRelativePath(),
                current.packageSha256(),
                current.archiveSha256(),
                current.encryptionAlgorithm(),
                current.documentCount(),
                remotePath,
                current.createdAt(),
                completedAt,
                lastErrorCode);
    }

    private void persistRecord(DeliveryRecord record) throws IOException {
        Path target = stateFile(record.batchId());
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        try {
            objectMapper.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), record);
            moveAtomically(temporary, target);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private Path stateFile(String batchId) {
        return stateRoot.resolve(batchId + ".json");
    }

    private String sha256(Path path) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            return sha256(input);
        }
    }

    private String sha256(InputStream input) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) {
                    digest.update(buffer, 0, read);
                }
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_RUNTIME_9007, "SHA-256 is unavailable", e);
        }
    }

    private void moveAtomically(Path source, Path target) throws IOException {
        Files.createDirectories(target.getParent());
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

    private void restrictToOwner(Path path) throws IOException {
        PosixFileAttributeView view =
                Files.getFileAttributeView(path, PosixFileAttributeView.class);
        if (view != null) {
            Files.setPosixFilePermissions(
                    path,
                    EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        }
    }

    private record DeliverySource(String internalFilename, OutputFile output) {}

    private record PreparedPackage(DeliveryRecord record, Path archivePath) {}

    private record ValidatedDelivery(DeliveryProfile profile, DeliveryCredentials credentials) {}
}
