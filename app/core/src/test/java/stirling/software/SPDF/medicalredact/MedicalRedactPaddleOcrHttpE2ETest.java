package stirling.software.SPDF.medicalredact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit.jupiter.SpringExtension;

import stirling.software.common.model.ApplicationProperties;

import tools.jackson.databind.ObjectMapper;

@ExtendWith(SpringExtension.class)
@ContextConfiguration(classes = MedicalRedactPaddleOcrHttpE2ETest.TestConfig.class)
class MedicalRedactPaddleOcrHttpE2ETest {

    @Autowired private MedicalRedactController controller;
    @Autowired private MedicalRedactTextService textService;
    @Autowired private MedicalRedactOcrGateway ocrGateway;

    @Test
    void springContextWiresTheProductionMedicalRedactEngineClient() {
        assertThat(controller).isNotNull();
        assertThat(textService).isNotNull();
        assertThat(ocrGateway).isInstanceOf(MedicalRedactEngineClient.class);
    }

    @Configuration
    @Import({MedicalRedactController.class, MedicalRedactRuntimeCapabilitiesService.class})
    static class TestConfig {

        @Bean
        ObjectMapper objectMapper() {
            return new ObjectMapper();
        }

        @Bean
        ApplicationProperties applicationProperties() {
            return new ApplicationProperties();
        }

        @Bean
        MedicalRedactWorkspaceService medicalRedactWorkspaceService(ObjectMapper objectMapper)
                throws IOException {
            Path root = Files.createTempDirectory("medical-redact-spring-context-");
            return new MedicalRedactWorkspaceService(objectMapper, root);
        }

        @Bean
        MedicalRedactDeliveryService medicalRedactDeliveryService() {
            return mock(MedicalRedactDeliveryService.class);
        }

        @Bean
        MedicalRedactOcrGateway medicalRedactOcrGateway(
                ApplicationProperties applicationProperties, ObjectMapper objectMapper) {
            return new MedicalRedactEngineClient(applicationProperties, objectMapper);
        }

        @Bean
        MedicalRedactTextService medicalRedactTextService(
                MedicalRedactWorkspaceService workspaceService,
                MedicalRedactOcrGateway ocrGateway) {
            return new MedicalRedactTextService(workspaceService, ocrGateway);
        }
    }
}
