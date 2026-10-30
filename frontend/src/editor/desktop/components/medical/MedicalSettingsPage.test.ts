import { describe, expect, it } from "vitest";
import type { MedicalRedactRuntimeCapabilities } from "@app/services/medicalRedactTaskService";
import { formatRuntimeCapabilities } from "@app/components/medical/MedicalSettingsPage";

function capabilities(
  availableRuntimes: string[],
): MedicalRedactRuntimeCapabilities {
  return {
    os: "Windows",
    osVersion: "11",
    arch: "x64",
    cpuModel: "AMD Ryzen 7 7700",
    physicalCores: 8,
    logicalCores: 16,
    totalMemoryBytes: 32 * 1024 * 1024 * 1024,
    appleSilicon: false,
    nvidiaGpu: true,
    nvidiaGpuName: "NVIDIA GeForce RTX 4060",
    nvidiaVramBytes: 8 * 1024 * 1024 * 1024,
    availableRuntimes,
    detectedAccelerators: ["NVIDIA"],
    workerSchedule: {
      memoryTier: "HIGH",
      ocrWorkers: 1,
      nerWorkers: 1,
      preprocessWorkers: 2,
      renderCachePages: 8,
      ocrModelTier: "SMALL",
      optionalModelsEnabled: true,
    },
  };
}

describe("formatRuntimeCapabilities", () => {
  it("renders Windows CUDA runtimes as user-facing Chinese labels", () => {
    expect(
      formatRuntimeCapabilities(
        capabilities(["CPU", "ONNX_CUDA", "PADDLE_GPU"]),
      ),
    ).toEqual({
      runtimes: "CPU、ONNX Runtime（NVIDIA CUDA）、Paddle（NVIDIA GPU）",
      accelerators: "NVIDIA GPU",
    });
  });

  it("keeps CPU fallback labels explicit", () => {
    expect(
      formatRuntimeCapabilities(capabilities(["CPU", "ONNX_CPU", "PADDLE_CPU"]))
        .runtimes,
    ).toBe("CPU、ONNX Runtime（CPU）、Paddle（CPU）");
  });
});
