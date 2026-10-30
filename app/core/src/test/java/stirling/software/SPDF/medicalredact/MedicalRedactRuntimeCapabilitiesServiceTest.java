package stirling.software.SPDF.medicalredact;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.Test;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.EngineRuntimeCapabilities;

class MedicalRedactRuntimeCapabilitiesServiceTest {

    @Test
    void currentMachineAlwaysKeepsCpuRuntimeAvailable() {
        var capabilities = new MedicalRedactRuntimeCapabilitiesService().probe();

        assertFalse(capabilities.os().isBlank());
        assertFalse(capabilities.arch().isBlank());
        assertTrue(capabilities.physicalCores() > 0);
        assertTrue(capabilities.logicalCores() > 0);
        assertTrue(capabilities.totalMemoryBytes() >= 0);
        assertEquals(List.of("CPU"), capabilities.availableRuntimes());
    }

    @Test
    void reportsCoremlOnlyWhenEngineActuallyInitializedIt() {
        MedicalRedactEngineClient engineClient = mock(MedicalRedactEngineClient.class);
        when(engineClient.runtimeCapabilities())
                .thenReturn(
                        Optional.of(
                                new EngineRuntimeCapabilities(
                                        true,
                                        "COREML",
                                        List.of("COREML"),
                                        List.of("COREML", "ONNX_CPU", "PADDLE_CPU"),
                                        List.of("CoreMLExecutionProvider", "CPUExecutionProvider"),
                                        "1.31.1",
                                        List.of("PADDLE", "ONNX"),
                                        null)));
        MedicalRedactRuntimeCapabilitiesService service =
                new MedicalRedactRuntimeCapabilitiesService(
                        (command, timeout) ->
                                switch (String.join(" ", command)) {
                                    case "sysctl -n machdep.cpu.brand_string" ->
                                            Optional.of("Apple M1 Pro\n");
                                    case "sysctl -n hw.physicalcpu" -> Optional.of("8\n");
                                    case "sysctl -n hw.logicalcpu" -> Optional.of("8\n");
                                    default -> Optional.empty();
                                },
                        new MedicalRedactRuntimeCapabilitiesService.SystemSnapshot(
                                "Mac OS X", "15.3", "arm64", 8, 16L * 1024 * 1024 * 1024),
                        engineClient);

        var capabilities = service.probe();

        assertEquals(List.of("CPU", "COREML"), capabilities.availableRuntimes());
        assertEquals(List.of("APPLE_SILICON"), capabilities.detectedAccelerators());
        assertEquals("STANDARD", capabilities.workerSchedule().memoryTier());
        assertEquals(1, capabilities.workerSchedule().ocrWorkers());
        assertEquals(1, capabilities.workerSchedule().nerWorkers());
        assertEquals(2, capabilities.workerSchedule().preprocessWorkers());
        assertEquals(4, capabilities.workerSchedule().renderCachePages());
    }

    @Test
    void probesAppleSiliconWithoutClaimingCoremlRuntime() {
        MedicalRedactRuntimeCapabilitiesService service =
                new MedicalRedactRuntimeCapabilitiesService(
                        (command, timeout) ->
                                switch (String.join(" ", command)) {
                                    case "sysctl -n machdep.cpu.brand_string" ->
                                            Optional.of("Apple M1 Pro\n");
                                    case "sysctl -n hw.physicalcpu" -> Optional.of("8\n");
                                    case "sysctl -n hw.logicalcpu" -> Optional.of("8\n");
                                    default -> Optional.empty();
                                },
                        new MedicalRedactRuntimeCapabilitiesService.SystemSnapshot(
                                "Mac OS X", "15.3", "aarch64", 8, 16L * 1024 * 1024 * 1024));

        var capabilities = service.probe();

        assertEquals("macOS", capabilities.os());
        assertEquals("arm64", capabilities.arch());
        assertEquals("Apple M1 Pro", capabilities.cpuModel());
        assertEquals(8, capabilities.physicalCores());
        assertEquals(8, capabilities.logicalCores());
        assertEquals(16L * 1024 * 1024 * 1024, capabilities.totalMemoryBytes());
        assertTrue(capabilities.appleSilicon());
        assertFalse(capabilities.nvidiaGpu());
        assertEquals(List.of("CPU"), capabilities.availableRuntimes());
        assertEquals(List.of("APPLE_SILICON"), capabilities.detectedAccelerators());
    }

    @Test
    void reportsOnnxCudaOnlyWhenEngineActuallyInitializedItOnWindows() {
        MedicalRedactOcrGateway ocrGateway = mock(MedicalRedactOcrGateway.class);
        when(ocrGateway.runtimeCapabilities())
                .thenReturn(
                        Optional.of(
                                new EngineRuntimeCapabilities(
                                        true,
                                        "ONNX_CUDA",
                                        List.of("ONNX_CUDA"),
                                        List.of("ONNX_CUDA", "ONNX_CPU", "PADDLE_CPU"),
                                        List.of("CUDAExecutionProvider", "CPUExecutionProvider"),
                                        "1.31.1",
                                        List.of("PADDLE", "ONNX"),
                                        null)));
        MedicalRedactRuntimeCapabilitiesService.CommandRunner runner =
                new MedicalRedactRuntimeCapabilitiesService.CommandRunner() {
                    @Override
                    public Optional<String> run(List<String> command, Duration timeout) {
                        if ("powershell.exe".equals(command.getFirst())) {
                            return Optional.of("AMD Ryzen 7 7700|8|16");
                        }
                        if ("nvidia-smi".equals(command.getFirst())) {
                            return Optional.of("NVIDIA GeForce RTX 4060, 8192\n");
                        }
                        return Optional.empty();
                    }
                };
        MedicalRedactRuntimeCapabilitiesService service =
                new MedicalRedactRuntimeCapabilitiesService(
                        runner,
                        new MedicalRedactRuntimeCapabilitiesService.SystemSnapshot(
                                "Windows 11", "10.0", "amd64", 16, 32L * 1024 * 1024 * 1024),
                        ocrGateway);

        var capabilities = service.probe();

        assertTrue(capabilities.nvidiaGpu());
        assertEquals(List.of("CPU", "ONNX_CUDA"), capabilities.availableRuntimes());
        assertEquals(List.of("NVIDIA"), capabilities.detectedAccelerators());
        assertEquals("HIGH", capabilities.workerSchedule().memoryTier());
        assertEquals(1, capabilities.workerSchedule().ocrWorkers());
        assertEquals(2, capabilities.workerSchedule().preprocessWorkers());
        assertEquals(8, capabilities.workerSchedule().renderCachePages());
    }

    @Test
    void probesWindowsNvidiaGpuAndVramWithoutEnablingCudaRuntime() {
        MedicalRedactRuntimeCapabilitiesService.CommandRunner runner =
                new MedicalRedactRuntimeCapabilitiesService.CommandRunner() {
                    @Override
                    public Optional<String> run(List<String> command, Duration timeout) {
                        if ("powershell.exe".equals(command.getFirst())) {
                            return Optional.of("AMD Ryzen 7 7700|8|16");
                        }
                        if ("nvidia-smi".equals(command.getFirst())) {
                            return Optional.of("NVIDIA GeForce RTX 4060, 8192\n");
                        }
                        return Optional.empty();
                    }
                };
        MedicalRedactRuntimeCapabilitiesService service =
                new MedicalRedactRuntimeCapabilitiesService(
                        runner,
                        new MedicalRedactRuntimeCapabilitiesService.SystemSnapshot(
                                "Windows 11", "10.0", "amd64", 16, 32L * 1024 * 1024 * 1024));

        var capabilities = service.probe();

        assertEquals("Windows", capabilities.os());
        assertEquals("x64", capabilities.arch());
        assertEquals("AMD Ryzen 7 7700", capabilities.cpuModel());
        assertEquals(8, capabilities.physicalCores());
        assertEquals(16, capabilities.logicalCores());
        assertFalse(capabilities.appleSilicon());
        assertTrue(capabilities.nvidiaGpu());
        assertEquals("NVIDIA GeForce RTX 4060", capabilities.nvidiaGpuName());
        assertEquals(8192L * 1024 * 1024, capabilities.nvidiaVramBytes());
        assertEquals(List.of("CPU"), capabilities.availableRuntimes());
        assertEquals(List.of("NVIDIA"), capabilities.detectedAccelerators());
    }

    @Test
    void thirtyTwoGigabyteCpuRuntimeAllowsBoundedParallelOcr() {
        var schedule =
                MedicalRedactRuntimeCapabilitiesService.workerScheduleFor(
                        8, 32L * 1024 * 1024 * 1024, "ONNX_CPU");

        assertEquals("HIGH", schedule.memoryTier());
        assertEquals(2, schedule.ocrWorkers());
        assertEquals(1, schedule.nerWorkers());
        assertEquals(2, schedule.preprocessWorkers());
        assertEquals(8, schedule.renderCachePages());
        assertEquals("SMALL", schedule.ocrModelTier());
        assertTrue(schedule.optionalModelsEnabled());
    }

    @Test
    void lowMemoryScheduleDegradesCacheAndOptionalModelsBeforeCoreSafetyFeatures() {
        var schedule =
                MedicalRedactRuntimeCapabilitiesService.workerScheduleFor(
                        4, 6L * 1024 * 1024 * 1024, "ONNX_CPU");

        assertEquals("LOW", schedule.memoryTier());
        assertEquals(1, schedule.ocrWorkers());
        assertEquals(1, schedule.nerWorkers());
        assertEquals(1, schedule.preprocessWorkers());
        assertEquals(2, schedule.renderCachePages());
        assertEquals("TINY", schedule.ocrModelTier());
        assertFalse(schedule.optionalModelsEnabled());
    }

    @Test
    void commandProbeFailureFallsBackToSafeCpuCapabilities() {
        MedicalRedactRuntimeCapabilitiesService service =
                new MedicalRedactRuntimeCapabilitiesService(
                        (command, timeout) -> Optional.empty(),
                        new MedicalRedactRuntimeCapabilitiesService.SystemSnapshot(
                                "Mac OS X", "15.3", "x86_64", 12, 24L * 1024 * 1024 * 1024));

        var capabilities = service.probe();

        assertEquals("macOS", capabilities.os());
        assertEquals("x64", capabilities.arch());
        assertEquals("未知处理器", capabilities.cpuModel());
        assertEquals(12, capabilities.physicalCores());
        assertEquals(12, capabilities.logicalCores());
        assertFalse(capabilities.appleSilicon());
        assertFalse(capabilities.nvidiaGpu());
        assertNull(capabilities.nvidiaGpuName());
        assertNull(capabilities.nvidiaVramBytes());
        assertEquals(List.of("CPU"), capabilities.availableRuntimes());
        assertTrue(capabilities.detectedAccelerators().isEmpty());
        assertEquals("STANDARD", capabilities.workerSchedule().memoryTier());
        assertEquals(1, capabilities.workerSchedule().ocrWorkers());
    }
}
