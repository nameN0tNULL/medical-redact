package stirling.software.SPDF.medicalredact;

import java.util.List;

public final class MedicalRedactDeliveryModels {

    private MedicalRedactDeliveryModels() {}

    public enum DeliveryProtocol {
        SFTP,
        FTPS,
        FTP
    }

    public enum FtpsMode {
        EXPLICIT,
        IMPLICIT
    }

    public enum DeliveryStatus {
        NOT_DELIVERED,
        PACKAGED,
        UPLOADING,
        UPLOAD_FAILED,
        UPLOADED
    }

    public record DeliveryProfile(
            String profileId,
            DeliveryProtocol protocol,
            String host,
            int port,
            String username,
            String remoteDirectory,
            String credentialRef,
            String sftpHostKeyFingerprint,
            boolean ftpPassiveMode,
            FtpsMode ftpsMode) {}

    public record DeliveryCredentials(
            String password,
            String privateKey,
            String privateKeyPassphrase,
            String archivePassword) {}

    public record DeliveryRequest(DeliveryProfile profile, DeliveryCredentials credentials) {}

    public record DeliveryConnectionTestResult(boolean success) {}

    public record DeliveryManifestFile(
            String internalFilename,
            String sha256,
            long fileSize,
            int pageCount,
            String verificationStatus) {}

    public record DeliveryManifest(
            int schemaVersion,
            String packageId,
            String batchId,
            String createdAt,
            String appVersion,
            int documentCount,
            List<DeliveryManifestFile> files,
            String packageSha256,
            String encryptionAlgorithm,
            String deliveryTargetProfileId) {}

    public record DeliveryRecord(
            String batchId,
            DeliveryStatus status,
            String packageId,
            String profileId,
            String archiveFilename,
            String archiveRelativePath,
            String packageSha256,
            String archiveSha256,
            String encryptionAlgorithm,
            int documentCount,
            String remotePath,
            String createdAt,
            String completedAt,
            String lastErrorCode) {}
}
