package stirling.software.SPDF.medicalredact;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.EngineRuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.RuntimeCapabilities;
import stirling.software.SPDF.medicalredact.MedicalRedactModels.WorkerSchedule;

@Service
class MedicalRedactRuntimeCapabilitiesService {

    private static final Duration COMMAND_TIMEOUT = Duration.ofSeconds(2);
    private static final long MEBIBYTE = 1024L * 1024L;

    private final CommandRunner commandRunner;
    private final SystemSnapshot systemSnapshot;
    private final MedicalRedactOcrGateway ocrGateway;

    MedicalRedactRuntimeCapabilitiesService() {
        this(new ProcessCommandRunner(), SystemSnapshot.current(), null);
    }

    @Autowired
    MedicalRedactRuntimeCapabilitiesService(MedicalRedactOcrGateway ocrGateway) {
        this(new ProcessCommandRunner(), SystemSnapshot.current(), ocrGateway);
    }

    MedicalRedactRuntimeCapabilitiesService(
            CommandRunner commandRunner, SystemSnapshot systemSnapshot) {
        this(commandRunner, systemSnapshot, null);
    }

    MedicalRedactRuntimeCapabilitiesService(
            CommandRunner commandRunner,
            SystemSnapshot systemSnapshot,
            MedicalRedactOcrGateway ocrGateway) {
        this.commandRunner = commandRunner;
        this.systemSnapshot = systemSnapshot;
        this.ocrGateway = ocrGateway;
    }

    RuntimeCapabilities probe() {
        String os = normalizedOs(systemSnapshot.osName());
        String arch = normalizedArch(systemSnapshot.arch());
        int logicalCores = Math.max(1, systemSnapshot.logicalCores());
        int physicalCores = logicalCores;
        String cpuModel = "";
        boolean appleSilicon = false;

        if ("macOS".equals(os)) {
            cpuModel = runText(List.of("sysctl", "-n", "machdep.cpu.brand_string")).orElse("");
            physicalCores = runInt(List.of("sysctl", "-n", "hw.physicalcpu")).orElse(logicalCores);
            logicalCores = runInt(List.of("sysctl", "-n", "hw.logicalcpu")).orElse(logicalCores);
            appleSilicon = "arm64".equals(arch);
        } else if ("Windows".equals(os)) {
            WindowsCpuInfo cpuInfo = probeWindowsCpu();
            cpuModel = cpuInfo.model();
            physicalCores = cpuInfo.physicalCores() > 0 ? cpuInfo.physicalCores() : logicalCores;
            logicalCores = cpuInfo.logicalCores() > 0 ? cpuInfo.logicalCores() : logicalCores;
        } else if ("Linux".equals(os)) {
            LinuxCpuInfo cpuInfo = probeLinuxCpu();
            cpuModel = cpuInfo.model();
            physicalCores = cpuInfo.physicalCores() > 0 ? cpuInfo.physicalCores() : logicalCores;
        }

        if (cpuModel.isBlank()) {
            cpuModel = "未知处理器";
        }

        NvidiaInfo nvidia = probeNvidia();
        List<String> accelerators = new ArrayList<>();
        if (appleSilicon) {
            accelerators.add("APPLE_SILICON");
        }
        if (nvidia.detected()) {
            accelerators.add("NVIDIA");
        }

        Optional<EngineRuntimeCapabilities> engineCapabilities =
                ocrGateway == null ? Optional.empty() : ocrGateway.runtimeCapabilities();
        LinkedHashSet<String> availableRuntimes = new LinkedHashSet<>();
        availableRuntimes.add("CPU");
        engineCapabilities
                .filter(EngineRuntimeCapabilities::available)
                .map(EngineRuntimeCapabilities::selectedRuntime)
                .filter(runtime -> runtime != null && !runtime.isBlank())
                .ifPresent(availableRuntimes::add);

        int safePhysicalCores = Math.max(1, physicalCores);
        int safeLogicalCores = Math.max(1, logicalCores);
        long safeTotalMemoryBytes = Math.max(0L, systemSnapshot.totalMemoryBytes());
        String selectedRuntime =
                engineCapabilities
                        .filter(EngineRuntimeCapabilities::available)
                        .map(EngineRuntimeCapabilities::selectedRuntime)
                        .filter(runtime -> runtime != null && !runtime.isBlank())
                        .orElse("CPU");
        WorkerSchedule workerSchedule =
                workerScheduleFor(safePhysicalCores, safeTotalMemoryBytes, selectedRuntime);

        return new RuntimeCapabilities(
                os,
                systemSnapshot.osVersion(),
                arch,
                cpuModel.strip(),
                safePhysicalCores,
                safeLogicalCores,
                safeTotalMemoryBytes,
                appleSilicon,
                nvidia.detected(),
                nvidia.name(),
                nvidia.vramBytes(),
                List.copyOf(availableRuntimes),
                List.copyOf(accelerators),
                workerSchedule);
    }

    static WorkerSchedule workerScheduleFor(
            int physicalCores, long totalMemoryBytes, String selectedRuntime) {
        int cores = Math.max(1, physicalCores);
        long gibibytes = totalMemoryBytes <= 0 ? 0 : totalMemoryBytes / (1024L * 1024L * 1024L);
        boolean accelerated = Set.of("COREML", "ONNX_CUDA", "PADDLE_GPU").contains(selectedRuntime);

        if (gibibytes > 0 && gibibytes < 8) {
            return new WorkerSchedule("LOW", 1, 1, 1, 2, "TINY", false);
        }
        if (gibibytes > 0 && gibibytes < 16) {
            return new WorkerSchedule("CONSTRAINED", 1, 1, 1, 3, "SMALL", false);
        }
        if (gibibytes == 0 || gibibytes < 32) {
            int preprocessWorkers = cores >= 6 ? 2 : 1;
            return new WorkerSchedule(
                    gibibytes == 0 ? "SAFE_DEFAULT" : "STANDARD",
                    1,
                    1,
                    preprocessWorkers,
                    4,
                    "SMALL",
                    false);
        }

        int ocrWorkers = accelerated ? 1 : Math.min(4, Math.max(2, cores / 4));
        int preprocessWorkers = Math.min(4, Math.max(2, cores / 3));
        int renderCachePages = gibibytes >= 64 ? 10 : 8;
        return new WorkerSchedule(
                "HIGH", ocrWorkers, 1, preprocessWorkers, renderCachePages, "SMALL", true);
    }

    private WindowsCpuInfo probeWindowsCpu() {
        String script =
                "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
                        + "$c=Get-CimInstance Win32_Processor; "
                        + "$n=($c | Select-Object -First 1 -ExpandProperty Name); "
                        + "$p=($c | Measure-Object -Property NumberOfCores -Sum).Sum; "
                        + "$l=($c | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; "
                        + "Write-Output ($n + '|' + $p + '|' + $l)";
        return runText(
                        List.of(
                                "powershell.exe",
                                "-NoProfile",
                                "-NonInteractive",
                                "-Command",
                                script))
                .map(
                        output -> {
                            String[] parts = output.strip().split("\\|", -1);
                            if (parts.length < 3) {
                                return new WindowsCpuInfo("", 0, 0);
                            }
                            return new WindowsCpuInfo(
                                    parts[0].strip(),
                                    parsePositiveInt(parts[1]).orElse(0),
                                    parsePositiveInt(parts[2]).orElse(0));
                        })
                .orElseGet(() -> new WindowsCpuInfo("", 0, 0));
    }

    private LinuxCpuInfo probeLinuxCpu() {
        Path cpuInfoPath = Path.of("/proc/cpuinfo");
        if (!Files.isRegularFile(cpuInfoPath)) {
            return new LinuxCpuInfo("", 0);
        }
        try {
            String content = Files.readString(cpuInfoPath, StandardCharsets.UTF_8);
            String model = "";
            Set<String> physicalCoreIds = new LinkedHashSet<>();
            String physicalId = null;
            String coreId = null;
            for (String line : content.split("\\R")) {
                if (line.isBlank()) {
                    if (physicalId != null && coreId != null) {
                        physicalCoreIds.add(physicalId + ":" + coreId);
                    }
                    physicalId = null;
                    coreId = null;
                    continue;
                }
                int colon = line.indexOf(':');
                if (colon < 0) {
                    continue;
                }
                String key = line.substring(0, colon).strip();
                String value = line.substring(colon + 1).strip();
                if (model.isBlank() && ("model name".equals(key) || "Hardware".equals(key))) {
                    model = value;
                } else if ("physical id".equals(key)) {
                    physicalId = value;
                } else if ("core id".equals(key)) {
                    coreId = value;
                }
            }
            if (physicalId != null && coreId != null) {
                physicalCoreIds.add(physicalId + ":" + coreId);
            }
            return new LinuxCpuInfo(model, physicalCoreIds.size());
        } catch (IOException e) {
            return new LinuxCpuInfo("", 0);
        }
    }

    private NvidiaInfo probeNvidia() {
        Optional<String> output =
                runText(
                        List.of(
                                "nvidia-smi",
                                "--query-gpu=name,memory.total",
                                "--format=csv,noheader,nounits"));
        if (output.isEmpty() || output.get().isBlank()) {
            return new NvidiaInfo(false, null, null);
        }
        String firstLine = output.get().lines().findFirst().orElse("").strip();
        int comma = firstLine.lastIndexOf(',');
        if (comma < 0) {
            return new NvidiaInfo(true, firstLine, null);
        }
        String name = firstLine.substring(0, comma).strip();
        Long vramBytes =
                parsePositiveLong(firstLine.substring(comma + 1))
                        .map(value -> value * MEBIBYTE)
                        .orElse(null);
        return new NvidiaInfo(true, name.isBlank() ? null : name, vramBytes);
    }

    private Optional<String> runText(List<String> command) {
        return commandRunner
                .run(command, COMMAND_TIMEOUT)
                .map(String::strip)
                .filter(s -> !s.isBlank());
    }

    private Optional<Integer> runInt(List<String> command) {
        return runText(command).flatMap(MedicalRedactRuntimeCapabilitiesService::parsePositiveInt);
    }

    private static Optional<Integer> parsePositiveInt(String value) {
        try {
            int parsed = Integer.parseInt(value.strip());
            return parsed > 0 ? Optional.of(parsed) : Optional.empty();
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    private static Optional<Long> parsePositiveLong(String value) {
        try {
            long parsed = Long.parseLong(value.strip());
            return parsed > 0 ? Optional.of(parsed) : Optional.empty();
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    private static String normalizedOs(String value) {
        String normalized = value == null ? "" : value.toLowerCase(Locale.ROOT);
        if (normalized.contains("mac")) {
            return "macOS";
        }
        if (normalized.contains("win")) {
            return "Windows";
        }
        if (normalized.contains("linux")) {
            return "Linux";
        }
        return value == null || value.isBlank() ? "Unknown" : value.strip();
    }

    private static String normalizedArch(String value) {
        if (value == null || value.isBlank()) {
            return "unknown";
        }
        String normalized = value.toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "aarch64", "arm64" -> "arm64";
            case "x86_64", "amd64" -> "x64";
            default -> normalized;
        };
    }

    interface CommandRunner {
        Optional<String> run(List<String> command, Duration timeout);
    }

    record SystemSnapshot(
            String osName, String osVersion, String arch, int logicalCores, long totalMemoryBytes) {

        static SystemSnapshot current() {
            long totalMemory = 0L;
            java.lang.management.OperatingSystemMXBean baseBean =
                    ManagementFactory.getOperatingSystemMXBean();
            if (baseBean instanceof com.sun.management.OperatingSystemMXBean bean) {
                totalMemory = bean.getTotalMemorySize();
            }
            return new SystemSnapshot(
                    System.getProperty("os.name", ""),
                    System.getProperty("os.version", ""),
                    System.getProperty("os.arch", ""),
                    Runtime.getRuntime().availableProcessors(),
                    totalMemory);
        }
    }

    private record WindowsCpuInfo(String model, int physicalCores, int logicalCores) {}

    private record LinuxCpuInfo(String model, int physicalCores) {}

    private record NvidiaInfo(boolean detected, String name, Long vramBytes) {}

    private static final class ProcessCommandRunner implements CommandRunner {
        @Override
        public Optional<String> run(List<String> command, Duration timeout) {
            Process process = null;
            try {
                process = new ProcessBuilder(command).redirectErrorStream(true).start();
                if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    return Optional.empty();
                }
                if (process.exitValue() != 0) {
                    return Optional.empty();
                }
                return Optional.of(
                        new String(
                                process.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            } catch (IOException e) {
                return Optional.empty();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            } finally {
                if (process != null && process.isAlive()) {
                    process.destroyForcibly();
                }
            }
        }
    }
}
