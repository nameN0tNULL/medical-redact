package stirling.software.SPDF.medicalredact;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;

import javax.net.ssl.SSLException;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPReply;
import org.apache.commons.net.ftp.FTPSClient;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.UserInfo;

import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryCredentials;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProfile;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.DeliveryProtocol;
import stirling.software.SPDF.medicalredact.MedicalRedactDeliveryModels.FtpsMode;

interface MedicalRedactDeliveryClient extends AutoCloseable {

    void verifyWritableDirectory();

    void upload(java.nio.file.Path localFile, String remotePath);

    InputStream open(String remotePath);

    void rename(String source, String target);

    void delete(String remotePath);

    @Override
    void close();
}

@FunctionalInterface
interface MedicalRedactDeliveryClientFactory {
    MedicalRedactDeliveryClient connect(DeliveryProfile profile, DeliveryCredentials credentials);
}

final class DefaultMedicalRedactDeliveryClientFactory
        implements MedicalRedactDeliveryClientFactory {

    @Override
    public MedicalRedactDeliveryClient connect(
            DeliveryProfile profile, DeliveryCredentials credentials) {
        return switch (profile.protocol()) {
            case SFTP -> SftpDeliveryClient.connect(profile, credentials);
            case FTP, FTPS -> FtpDeliveryClient.connect(profile, credentials);
        };
    }
}

final class MedicalRedactDeliveryPaths {

    private MedicalRedactDeliveryPaths() {}

    static String directory(String value) {
        if (value == null || value.isBlank()) {
            return ".";
        }
        String normalized = value.trim().replace('\\', '/');
        if (normalized.indexOf('\0') >= 0) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8501,
                    "Remote directory contains a null byte");
        }
        for (String segment : normalized.split("/")) {
            if ("..".equals(segment)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8501,
                        "Remote directory must not contain parent traversal");
            }
        }
        return normalized;
    }

    static String join(String directory, String filename) {
        String dir = directory(directory);
        if (".".equals(dir) || dir.isBlank()) {
            return filename;
        }
        return dir.endsWith("/") ? dir + filename : dir + "/" + filename;
    }
}

final class FtpDeliveryClient implements MedicalRedactDeliveryClient {

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    private final FTPClient ftp;
    private final String remoteDirectory;

    private FtpDeliveryClient(FTPClient ftp, String remoteDirectory) {
        this.ftp = ftp;
        this.remoteDirectory = remoteDirectory;
    }

    static FtpDeliveryClient connect(DeliveryProfile profile, DeliveryCredentials credentials) {
        FTPClient ftp = clientFor(profile);
        ftp.setConnectTimeout(CONNECT_TIMEOUT_MS);
        ftp.setDefaultTimeout(READ_TIMEOUT_MS);
        ftp.setDataTimeout(Duration.ofMillis(READ_TIMEOUT_MS));
        try {
            ftp.connect(profile.host(), profile.port());
            if (!FTPReply.isPositiveCompletion(ftp.getReplyCode())) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8505,
                        "FTP server refused the connection");
            }
            if (ftp instanceof FTPSClient ftps) {
                ftps.execPBSZ(0);
                ftps.execPROT("P");
            }
            if (!ftp.login(profile.username(), credentials.password())) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8506, "FTP authentication failed");
            }
            if (profile.ftpPassiveMode()) {
                ftp.enterLocalPassiveMode();
            } else {
                ftp.enterLocalActiveMode();
            }
            ftp.setFileType(FTP.BINARY_FILE_TYPE);
            return new FtpDeliveryClient(
                    ftp, MedicalRedactDeliveryPaths.directory(profile.remoteDirectory()));
        } catch (MedicalRedactDeliveryException e) {
            disconnectQuietly(ftp);
            throw e;
        } catch (SSLException e) {
            disconnectQuietly(ftp);
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8508, "FTPS TLS handshake failed", e);
        } catch (IOException e) {
            disconnectQuietly(ftp);
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8505, "FTP connection failed", e);
        }
    }

    private static FTPClient clientFor(DeliveryProfile profile) {
        if (profile.protocol() == DeliveryProtocol.FTP) {
            return new FTPClient();
        }
        FTPSClient client = new FTPSClient(profile.ftpsMode() == FtpsMode.IMPLICIT);
        client.setTrustManager(defaultSystemTrustManager());
        client.setEndpointCheckingEnabled(true);
        return client;
    }

    private static X509TrustManager defaultSystemTrustManager() {
        try {
            TrustManagerFactory factory =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            factory.init((KeyStore) null);
            for (var manager : factory.getTrustManagers()) {
                if (manager instanceof X509TrustManager x509TrustManager) {
                    return x509TrustManager;
                }
            }
        } catch (GeneralSecurityException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8508,
                    "System TLS trust manager is unavailable",
                    e);
        }
        throw new MedicalRedactDeliveryException(
                MedicalRedactIssueCode.MR_DELIVERY_8508, "System TLS trust manager is unavailable");
    }

    @Override
    public void verifyWritableDirectory() {
        try {
            String originalDirectory = ftp.printWorkingDirectory();
            if (!ftp.changeWorkingDirectory(remoteDirectory)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8509,
                        "Remote FTP directory is unavailable");
            }
            String probe = ".medical-redact-write-" + UUID.randomUUID() + ".tmp";
            if (!ftp.storeFile(probe, new ByteArrayInputStream(new byte[0]))) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8510,
                        "Remote FTP directory is not writable");
            }
            if (!ftp.deleteFile(probe)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8510,
                        "Remote FTP test file could not be removed");
            }
            if (originalDirectory != null) {
                ftp.changeWorkingDirectory(originalDirectory);
            }
        } catch (MedicalRedactDeliveryException e) {
            throw e;
        } catch (IOException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8509,
                    "Unable to inspect the remote FTP directory",
                    e);
        }
    }

    @Override
    public void upload(java.nio.file.Path localFile, String remotePath) {
        try (InputStream input = java.nio.file.Files.newInputStream(localFile)) {
            if (!ftp.storeFile(remotePath, input)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8511, "FTP upload failed");
            }
        } catch (MedicalRedactDeliveryException e) {
            throw e;
        } catch (IOException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8511, "FTP upload failed", e);
        }
    }

    @Override
    public InputStream open(String remotePath) {
        try {
            InputStream stream = ftp.retrieveFileStream(remotePath);
            if (stream == null) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8513,
                        "Unable to read uploaded FTP file");
            }
            return new FilterInputStream(stream) {
                @Override
                public void close() throws IOException {
                    super.close();
                    if (!ftp.completePendingCommand()) {
                        throw new IOException("FTP transfer did not complete");
                    }
                }
            };
        } catch (MedicalRedactDeliveryException e) {
            throw e;
        } catch (IOException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8513, "Unable to read uploaded FTP file", e);
        }
    }

    @Override
    public void rename(String source, String target) {
        try {
            if (!ftp.rename(source, target)) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8512, "FTP remote rename failed");
            }
        } catch (MedicalRedactDeliveryException e) {
            throw e;
        } catch (IOException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8512, "FTP remote rename failed", e);
        }
    }

    @Override
    public void delete(String remotePath) {
        try {
            ftp.deleteFile(remotePath);
        } catch (IOException ignored) {
        }
    }

    @Override
    public void close() {
        try {
            ftp.logout();
        } catch (IOException ignored) {
        } finally {
            disconnectQuietly(ftp);
        }
    }

    private static void disconnectQuietly(FTPClient ftp) {
        if (!ftp.isConnected()) {
            return;
        }
        try {
            ftp.disconnect();
        } catch (IOException ignored) {
        }
    }
}

final class SftpDeliveryClient implements MedicalRedactDeliveryClient {

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    private final Session session;
    private final ChannelSftp channel;
    private final String remoteDirectory;

    private SftpDeliveryClient(Session session, ChannelSftp channel, String remoteDirectory) {
        this.session = session;
        this.channel = channel;
        this.remoteDirectory = remoteDirectory;
    }

    static SftpDeliveryClient connect(DeliveryProfile profile, DeliveryCredentials credentials) {
        JSch jsch = new JSch();
        try {
            if (credentials.privateKey() != null && !credentials.privateKey().isBlank()) {
                byte[] passphrase =
                        credentials.privateKeyPassphrase() == null
                                        || credentials.privateKeyPassphrase().isBlank()
                                ? null
                                : credentials
                                        .privateKeyPassphrase()
                                        .getBytes(StandardCharsets.UTF_8);
                jsch.addIdentity(
                        "medical-redact-delivery",
                        credentials.privateKey().getBytes(StandardCharsets.UTF_8),
                        null,
                        passphrase);
            }
            Session session = jsch.getSession(profile.username(), profile.host(), profile.port());
            if (credentials.password() != null && !credentials.password().isBlank()) {
                session.setPassword(credentials.password().getBytes(StandardCharsets.UTF_8));
            }
            session.setHostKeyRepository(
                    new FingerprintHostKeyRepository(profile.sftpHostKeyFingerprint()));
            session.setConfig("StrictHostKeyChecking", "yes");
            session.connect(CONNECT_TIMEOUT_MS);
            session.setTimeout(READ_TIMEOUT_MS);
            ChannelSftp channel = (ChannelSftp) session.openChannel("sftp");
            channel.connect(CONNECT_TIMEOUT_MS);
            return new SftpDeliveryClient(
                    session,
                    channel,
                    MedicalRedactDeliveryPaths.directory(profile.remoteDirectory()));
        } catch (JSchException e) {
            throw classifyConnectionFailure(e);
        }
    }

    private static MedicalRedactDeliveryException classifyConnectionFailure(JSchException e) {
        Throwable cause = e.getCause();
        if (cause instanceof UnknownHostException
                || cause instanceof ConnectException
                || cause instanceof SocketTimeoutException) {
            return new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8505, "SFTP network connection failed", e);
        }
        String message = e.getMessage() == null ? "" : e.getMessage().toLowerCase(Locale.ROOT);
        if (message.contains("auth fail") || message.contains("authentication")) {
            return new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8506, "SFTP authentication failed", e);
        }
        if (message.contains("hostkey")
                || message.contains("host key")
                || message.contains("fingerprint")) {
            return new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8507,
                    "SFTP host key verification failed",
                    e);
        }
        return new MedicalRedactDeliveryException(
                MedicalRedactIssueCode.MR_DELIVERY_8508, "SFTP SSH connection failed", e);
    }

    @Override
    public void verifyWritableDirectory() {
        try {
            if (!channel.stat(remoteDirectory).isDir()) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8509,
                        "Remote SFTP directory is unavailable");
            }
        } catch (MedicalRedactDeliveryException e) {
            throw e;
        } catch (SftpException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8509,
                    "Remote SFTP directory is unavailable",
                    e);
        }
        String probe =
                MedicalRedactDeliveryPaths.join(
                        remoteDirectory, ".medical-redact-write-" + UUID.randomUUID() + ".tmp");
        try {
            channel.put(new ByteArrayInputStream(new byte[0]), probe);
            channel.rm(probe);
        } catch (SftpException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8510,
                    "Remote SFTP directory is not writable",
                    e);
        }
    }

    @Override
    public void upload(java.nio.file.Path localFile, String remotePath) {
        try (InputStream input = java.nio.file.Files.newInputStream(localFile)) {
            channel.put(input, remotePath);
        } catch (IOException | SftpException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8511, "SFTP upload failed", e);
        }
    }

    @Override
    public InputStream open(String remotePath) {
        try {
            return channel.get(remotePath);
        } catch (SftpException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8513,
                    "Unable to read uploaded SFTP file",
                    e);
        }
    }

    @Override
    public void rename(String source, String target) {
        try {
            channel.rename(source, target);
        } catch (SftpException e) {
            throw new MedicalRedactDeliveryException(
                    MedicalRedactIssueCode.MR_DELIVERY_8512, "SFTP remote rename failed", e);
        }
    }

    @Override
    public void delete(String remotePath) {
        try {
            channel.rm(remotePath);
        } catch (SftpException ignored) {
        }
    }

    @Override
    public void close() {
        channel.disconnect();
        session.disconnect();
    }

    private static final class FingerprintHostKeyRepository implements HostKeyRepository {

        private final String expected;

        private FingerprintHostKeyRepository(String fingerprint) {
            if (fingerprint == null || fingerprint.isBlank()) {
                throw new MedicalRedactDeliveryException(
                        MedicalRedactIssueCode.MR_DELIVERY_8501,
                        "SFTP host key fingerprint is required");
            }
            String normalized = fingerprint.trim();
            if (normalized.toUpperCase(Locale.ROOT).startsWith("SHA256:")) {
                normalized = normalized.substring("SHA256:".length());
            }
            this.expected = normalized.replace("=", "");
        }

        @Override
        public int check(String host, byte[] key) {
            return expected.equals(sha256Fingerprint(key)) ? OK : CHANGED;
        }

        private static String sha256Fingerprint(byte[] key) {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                return Base64.getEncoder().withoutPadding().encodeToString(digest.digest(key));
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException("SHA-256 unavailable", e);
            }
        }

        @Override
        public void add(HostKey hostkey, UserInfo ui) {}

        @Override
        public void remove(String host, String type) {}

        @Override
        public void remove(String host, String type, byte[] key) {}

        @Override
        public String getKnownHostsRepositoryID() {
            return "medical-redact-pinned-fingerprint";
        }

        @Override
        public HostKey[] getHostKey() {
            return new HostKey[0];
        }

        @Override
        public HostKey[] getHostKey(String host, String type) {
            return new HostKey[0];
        }
    }
}
