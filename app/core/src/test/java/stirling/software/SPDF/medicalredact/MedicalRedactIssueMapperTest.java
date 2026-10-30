package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.VerificationReport;

import tools.jackson.databind.ObjectMapper;

class MedicalRedactIssueMapperTest {

    @Test
    void mapsCurrentLegacyWarningsAndVerificationFindingsToGlobalCodes() {
        assertEquals(
                "MR-OCR-3008",
                MedicalRedactIssueMapper.protocolCode("PADDLEOCR_RUNTIME_UNAVAILABLE"));
        assertEquals(
                "MR-ALIGN-5112",
                MedicalRedactIssueMapper.protocolCode("LOCAL_REOCR_NO_SAFE_MATCH"));
        assertEquals(
                "MR-RUNTIME-9005", MedicalRedactIssueMapper.protocolCode("AI_ENGINE_HTTP_503"));

        List<MedicalRedactIssue> issues =
                MedicalRedactIssueMapper.verificationIssues(
                        List.of("OUTPUT_OCR_UNAVAILABLE", "KNOWN_VALUE_SURVIVED"));
        assertEquals(
                List.of("MR-VERIFY-7006", "MR-VERIFY-7004"),
                issues.stream().map(MedicalRedactIssue::code).toList());
        assertTrue(issues.stream().allMatch(issue -> "BLOCKING".equals(issue.severity())));
    }

    @Test
    void everyCurrentLegacyWarningAndFindingHasAGlobalMapping() {
        List<String> legacyCodes =
                List.of(
                        "NER_UNAVAILABLE",
                        "LOCAL_PII_ENGINE_UNAVAILABLE",
                        "PII_ENGINE_UNAVAILABLE",
                        "OCR_NO_TEXT_DETECTED",
                        "OCR_LOW_CONFIDENCE_PRESENT",
                        "OCR_INVALID_REQUEST_IMAGE",
                        "OCR_IMAGE_DECODE_FAILED",
                        "OCR_IMAGE_DIMENSION_MISMATCH",
                        "OCR_TRANSFORM_NON_INVERTIBLE",
                        "PADDLEOCR_MODEL_MISSING",
                        "PADDLEOCR_RUNTIME_UNAVAILABLE",
                        "PADDLEOCR_INFERENCE_FAILED",
                        "LOCAL_OCR_ENGINE_UNAVAILABLE",
                        "NO_SOURCE_TOKEN",
                        "INVALID_TOKEN_POLYGON",
                        "PARTIAL_TOKEN_NEEDS_REOCR",
                        "MISSING_BBOX",
                        "BBOX_OUT_OF_BOUNDS",
                        "TOKEN_REGION_MAPPING_CONFLICT",
                        "LOCAL_REOCR_FAILED",
                        "LOCAL_REOCR_FUZZY_MATCH",
                        "LOCAL_REOCR_MISSING_BBOX",
                        "LOCAL_REOCR_PAGE_MISMATCH",
                        "LOCAL_REOCR_INVALID_BBOX",
                        "LOCAL_REOCR_IMAGE_DECODE_FAILED",
                        "LOCAL_REOCR_IMAGE_DIMENSION_MISMATCH",
                        "LOCAL_REOCR_INVALID_CROP",
                        "LOCAL_REOCR_IMAGE_ENCODE_FAILED",
                        "LOCAL_REOCR_UNAVAILABLE",
                        "LOCAL_REOCR_NO_TEXT",
                        "LOCAL_REOCR_NO_SAFE_MATCH",
                        "LOCAL_REOCR_NO_CHAR_BOX",
                        "LOCAL_REOCR_MULTI_PAGE_UNSUPPORTED",
                        "LOCAL_REOCR_LIMIT_EXCEEDED",
                        "LOCAL_REOCR_IMAGE_UNAVAILABLE",
                        "AI_ENGINE_DISABLED",
                        "AI_ENGINE_TIMEOUT",
                        "AI_ENGINE_UNREACHABLE",
                        "AI_ENGINE_INTERRUPTED",
                        "AI_ENGINE_HTTP_503",
                        "NO_SELECTED_REDACTION",
                        "UNRESOLVED_PII_RISK",
                        "VERIFICATION_OUTPUT_READ_FAILED",
                        "KNOWN_VALUE_SURVIVED",
                        "OUTPUT_PII_DETECTED",
                        "OUTPUT_OCR_UNAVAILABLE",
                        "OUTPUT_PII_SCAN_UNAVAILABLE",
                        "TEXT_LAYER_SURVIVED",
                        "PDF_STRUCTURE_SURVIVED",
                        "METADATA_SURVIVED",
                        "ANNOTATION_SURVIVED",
                        "PAGE_COUNT_MISMATCH",
                        "REDACTION_BOX_NOT_BLACK",
                        "SEMANTIC_VERIFICATION_FAILED");

        for (String legacyCode : legacyCodes) {
            assertFalse(
                    "MR-GEN-0001".equals(MedicalRedactIssueMapper.protocolCode(legacyCode)),
                    () -> "Missing global issue mapping for " + legacyCode);
        }
    }

    @Test
    void unknownVerificationFindingFailsClosed() {
        List<MedicalRedactIssue> issues =
                MedicalRedactIssueMapper.verificationIssues(List.of("UNKNOWN_FINDING"));
        assertEquals(1, issues.size());
        assertEquals("MR-VERIFY-7099", issues.getFirst().code());
        assertEquals("BLOCKING", issues.getFirst().severity());
    }

    @Test
    void legacyVerificationDataMigratesToIssuesWithoutSerializingEnglishFields() throws Exception {
        VerificationReport report =
                new VerificationReport(
                        "report-1",
                        "document-1",
                        "BLOCKED",
                        1,
                        "2026-10-27T00:00:00Z",
                        null,
                        null,
                        null,
                        0,
                        1,
                        null,
                        "Secure-raster verification found unresolved output risks",
                        List.of("OUTPUT_OCR_UNAVAILABLE"));

        assertEquals(1, report.issues().size());
        assertEquals("MR-VERIFY-7006", report.issues().getFirst().code());

        String json = new ObjectMapper().writeValueAsString(report);
        assertTrue(json.contains("\"issues\""));
        assertTrue(json.contains("MR-VERIFY-7006"));
        assertFalse(json.contains("Secure-raster"));
        assertFalse(json.contains("OUTPUT_OCR_UNAVAILABLE"));
        assertFalse(json.contains("\"message\""));
        assertFalse(json.contains("\"findingCodes\""));
    }
}
