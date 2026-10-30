package stirling.software.SPDF.medicalredact;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.RuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.WorkerSchedule;

class MedicalRedactControllerTest {

    @Test
    void runtimeCapabilitiesEndpointReturnsTypedHardwareSnapshot() throws Exception {
        MedicalRedactWorkspaceService workspaceService = mock(MedicalRedactWorkspaceService.class);
        MedicalRedactDeliveryService deliveryService = mock(MedicalRedactDeliveryService.class);
        MedicalRedactTextService textService = mock(MedicalRedactTextService.class);
        MedicalRedactRuntimeCapabilitiesService runtimeCapabilitiesService =
                mock(MedicalRedactRuntimeCapabilitiesService.class);
        when(runtimeCapabilitiesService.probe())
                .thenReturn(
                        new RuntimeCapabilities(
                                "macOS",
                                "15.3",
                                "arm64",
                                "Apple M1 Pro",
                                8,
                                8,
                                17179869184L,
                                true,
                                false,
                                null,
                                null,
                                List.of("CPU"),
                                List.of("APPLE_SILICON"),
                                new WorkerSchedule("STANDARD", 1, 1, 2, 4, "SMALL", false)));

        MockMvc mvc =
                MockMvcBuilders.standaloneSetup(
                                new MedicalRedactController(
                                        workspaceService,
                                        deliveryService,
                                        textService,
                                        runtimeCapabilitiesService))
                        .build();

        mvc.perform(get("/api/v1/medical-redact/runtime/capabilities"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.os").value("macOS"))
                .andExpect(jsonPath("$.arch").value("arm64"))
                .andExpect(jsonPath("$.cpuModel").value("Apple M1 Pro"))
                .andExpect(jsonPath("$.physicalCores").value(8))
                .andExpect(jsonPath("$.logicalCores").value(8))
                .andExpect(jsonPath("$.totalMemoryBytes").value(17179869184L))
                .andExpect(jsonPath("$.appleSilicon").value(true))
                .andExpect(jsonPath("$.nvidiaGpu").value(false))
                .andExpect(jsonPath("$.availableRuntimes[0]").value("CPU"))
                .andExpect(jsonPath("$.detectedAccelerators[0]").value("APPLE_SILICON"))
                .andExpect(jsonPath("$.workerSchedule.ocrWorkers").value(1))
                .andExpect(jsonPath("$.workerSchedule.nerWorkers").value(1))
                .andExpect(jsonPath("$.workerSchedule.preprocessWorkers").value(2))
                .andExpect(jsonPath("$.workerSchedule.renderCachePages").value(4));
    }

    @Test
    void deliveryErrorReturnsGlobalCodeWithoutTransportExceptionMessage() throws Exception {
        MedicalRedactWorkspaceService workspaceService = mock(MedicalRedactWorkspaceService.class);
        MedicalRedactDeliveryService deliveryService = mock(MedicalRedactDeliveryService.class);
        MedicalRedactTextService textService = mock(MedicalRedactTextService.class);
        MedicalRedactRuntimeCapabilitiesService runtimeCapabilitiesService =
                mock(MedicalRedactRuntimeCapabilitiesService.class);
        when(deliveryService.testConnection(any()))
                .thenThrow(
                        new MedicalRedactDeliveryException(
                                MedicalRedactIssueCode.MR_DELIVERY_8506,
                                "SFTP authentication failed for secret user"));

        MockMvc mvc =
                MockMvcBuilders.standaloneSetup(
                                new MedicalRedactController(
                                        workspaceService,
                                        deliveryService,
                                        textService,
                                        runtimeCapabilitiesService))
                        .build();

        mvc.perform(
                        post("/api/v1/medical-redact/delivery/test-connection")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(
                                        """
                                        {
                                          "profile": {
                                            "profileId": "default",
                                            "protocol": "SFTP",
                                            "host": "localhost",
                                            "port": 22,
                                            "username": "delivery",
                                            "remoteDirectory": "/incoming",
                                            "credentialRef": "default",
                                            "sftpHostKeyFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                                            "ftpPassiveMode": true,
                                            "ftpsMode": null
                                          },
                                          "credentials": {
                                            "password": "not-logged",
                                            "privateKey": null,
                                            "privateKeyPassphrase": null,
                                            "archivePassword": null
                                          }
                                        }
                                        """))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.code").value("MR-DELIVERY-8506"))
                .andExpect(jsonPath("$.message").doesNotExist())
                .andExpect(jsonPath("$.detail").doesNotExist())
                .andExpect(content().string(not(containsString("secret user"))))
                .andExpect(content().string(not(containsString("not-logged"))));
    }

    @Test
    void validationErrorReturnsGlobalCodeWithoutEnglishExceptionMessage() throws Exception {
        MedicalRedactWorkspaceService workspaceService = mock(MedicalRedactWorkspaceService.class);
        MedicalRedactDeliveryService deliveryService = mock(MedicalRedactDeliveryService.class);
        MedicalRedactTextService textService = mock(MedicalRedactTextService.class);
        MedicalRedactRuntimeCapabilitiesService runtimeCapabilitiesService =
                mock(MedicalRedactRuntimeCapabilitiesService.class);
        when(workspaceService.createBatch(any(), anyList()))
                .thenThrow(
                        new IllegalArgumentException("Batch name must be 120 characters or fewer"));

        MockMvc mvc =
                MockMvcBuilders.standaloneSetup(
                                new MedicalRedactController(
                                        workspaceService,
                                        deliveryService,
                                        textService,
                                        runtimeCapabilitiesService))
                        .build();

        mvc.perform(
                        post("/api/v1/medical-redact/batches")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"name\":\"x\",\"knownEntities\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MR-TASK-1003"))
                .andExpect(jsonPath("$.params").isMap())
                .andExpect(jsonPath("$.traceId").isString())
                .andExpect(jsonPath("$.message").doesNotExist())
                .andExpect(jsonPath("$.detail").doesNotExist())
                .andExpect(
                        content()
                                .string(
                                        not(
                                                containsString(
                                                        "Batch name must be 120 characters or fewer"))));
    }
}
