package stirling.software.SPDF.medicalredact;

public class MedicalRedactDeliveryException extends RuntimeException {

    private final MedicalRedactIssueCode issueCode;

    public MedicalRedactDeliveryException(MedicalRedactIssueCode issueCode, String message) {
        super(message);
        this.issueCode = issueCode;
    }

    public MedicalRedactDeliveryException(
            MedicalRedactIssueCode issueCode, String message, Throwable cause) {
        super(message, cause);
        this.issueCode = issueCode;
    }

    public MedicalRedactIssueCode issueCode() {
        return issueCode;
    }
}
