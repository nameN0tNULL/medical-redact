#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const ENGINE_DIR = join(ROOT, "engine");
const VERSION_FILE = join(
  ROOT,
  "app",
  "common",
  "src",
  "main",
  "resources",
  "version.properties",
);
const SOURCE_MODELS = join(ROOT, ".cache", "medical-redact", "models");
const NER_MANIFEST = join(
  ENGINE_DIR,
  "src",
  "stirling",
  "medical_redact",
  "model-manifest.json",
);
const TAURI_DIR = join(ROOT, "frontend", "src-tauri");
const STAGED_MODELS = join(TAURI_DIR, "models");
const BUILD_ROOT = join(ROOT, ".build-cache", "medical-redact-engine");
const PYINSTALLER_VERSION = "6.16.0";
const ENGINE_API_CONTRACT_VERSION = 1;

const OCR_MODELS = [
  "PP-LCNet_x1_0_doc_ori_infer",
  "PP-LCNet_x1_0_textline_ori_infer",
  "PP-OCRv6_small_det_infer",
  "PP-OCRv6_small_rec_infer",
];
const OCR_FILES = [
  "inference.json",
  "inference.pdiparams",
  "inference.yml",
  "inference.onnx",
];

const action = process.argv[2] ?? "help";
const requestedPlatform = process.argv
  .slice(3)
  .find((arg) => arg.startsWith("--platform="))
  ?.split("=")[1];

function platformName() {
  if (requestedPlatform) return requestedPlatform;
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

function fail(message) {
  console.error(`[medical-redact-engine] FATAL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[medical-redact-engine] ${message}`);
}

function ensureNativePlatform(platform) {
  const native =
    (platform === "macos" && process.platform === "darwin") ||
    (platform === "windows" && process.platform === "win32");
  if (!native) {
    fail(
      `${platform} Engine must be built on its native OS; cross-platform PyInstaller builds are unsupported`,
    );
  }
}

function readBundleVersion() {
  if (!existsSync(VERSION_FILE)) {
    fail(`missing version file: ${VERSION_FILE}`);
  }
  const match = readFileSync(VERSION_FILE, "utf8").match(/^version=(.+)$/m);
  if (!match) fail("version.properties has no version= entry");
  return match[1].trim();
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function modelDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function copyVerifiedFile(source, destination) {
  if (!existsSync(source)) {
    fail(`required model file is missing: ${source}`);
  }
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(source, destination);
}

function stageModels(bundleVersion, platform) {
  rmSync(join(STAGED_MODELS, "paddleocr"), { recursive: true, force: true });
  rmSync(join(STAGED_MODELS, "ner"), { recursive: true, force: true });
  rmSync(join(STAGED_MODELS, "model-manifest.json"), { force: true });
  mkdirSync(STAGED_MODELS, { recursive: true });

  const models = [];
  for (const modelId of OCR_MODELS) {
    const files = [];
    for (const filename of OCR_FILES) {
      const source = join(SOURCE_MODELS, modelId, filename);
      const destination = join(STAGED_MODELS, "paddleocr", modelId, filename);
      copyVerifiedFile(source, destination);
      const file = {
        path: relative(STAGED_MODELS, destination).split("\\").join("/"),
        sha256: sha256(destination),
        size: statSync(destination).size,
      };
      files.push(file);
    }
    models.push({
      id: modelId,
      version: "paddle3.0.0",
      files,
      sha256: modelDigest(files),
      size: files.reduce((sum, file) => sum + file.size, 0),
      backend: ["paddle", "onnxruntime"],
      runtime: { paddle: true, onnx: true },
      platform: ["macos", "windows"],
    });
  }

  const nerDestination = join(STAGED_MODELS, "ner", "model-manifest.json");
  copyVerifiedFile(NER_MANIFEST, nerDestination);
  const nerFiles = [
    {
      path: relative(STAGED_MODELS, nerDestination).split("\\").join("/"),
      sha256: sha256(nerDestination),
      size: statSync(nerDestination).size,
    },
  ];
  models.push({
    id: "medical-zh-context-ner-v1",
    version: "1",
    files: nerFiles,
    sha256: modelDigest(nerFiles),
    size: nerFiles[0].size,
    backend: ["builtin-context"],
    runtime: { cpu: true },
    platform: ["macos", "windows"],
  });

  const manifest = {
    schemaVersion: 1,
    bundleVersion,
    generatedFor: {
      platform,
      arch: process.arch,
    },
    models,
  };
  writeFileSync(
    join(STAGED_MODELS, "model-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  info(`staged ${models.length} model entries at ${STAGED_MODELS}`);
}

function run(command, args, options = {}) {
  info(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

function packagingEnvironment() {
  const env = { ...process.env };
  delete env.VIRTUAL_ENV;
  delete env.PYTHONPATH;
  env.UV_PROJECT_ENVIRONMENT = join(ENGINE_DIR, ".venv");
  return env;
}

function engineVenvExecutable(name) {
  return process.platform === "win32"
    ? join(ENGINE_DIR, ".venv", "Scripts", `${name}.exe`)
    : join(ENGINE_DIR, ".venv", "bin", name);
}

function buildEngine(bundleVersion, platform) {
  ensureNativePlatform(platform);
  const buildRoot = join(BUILD_ROOT, platform);
  const distRoot = join(buildRoot, "dist");
  const workRoot = join(buildRoot, "work");
  const specRoot = join(buildRoot, "spec");
  const stagedEngineRoot = join(TAURI_DIR, "medical-engine");
  const stagedEngine = join(stagedEngineRoot, platform);

  rmSync(buildRoot, { recursive: true, force: true });
  // Tauri bundles medical-engine/**/*, so never leave another platform's
  // generated sidecar beside the current one. A shared checkout moved from
  // macOS to Windows must not accidentally ship both native runtimes.
  rmSync(stagedEngineRoot, { recursive: true, force: true });
  mkdirSync(specRoot, { recursive: true });

  const executableName =
    process.platform === "win32"
      ? "medical-redact-engine.exe"
      : "medical-redact-engine";

  const env = packagingEnvironment();
  run(
    "uv",
    ["sync", "--locked", "--group", "engine", "--group", "engine-package"],
    { cwd: ENGINE_DIR, env },
  );

  const pyinstaller = engineVenvExecutable("pyinstaller");
  if (!existsSync(pyinstaller)) {
    fail(`PyInstaller executable is missing after uv sync: ${pyinstaller}`);
  }

  run(
    pyinstaller,
    [
      "--noconfirm",
      "--clean",
      "--onedir",
      "--name",
      "medical-redact-engine",
      "--distpath",
      distRoot,
      "--workpath",
      workRoot,
      "--specpath",
      specRoot,
      "--paths",
      "src",
      "--collect-all",
      "paddleocr",
      "--collect-all",
      "paddlex",
      "--collect-all",
      "paddle",
      "--collect-all",
      "onnxruntime",
      "--collect-all",
      "presidio_analyzer",
      "--collect-all",
      "cv2",
      "--copy-metadata",
      "imagesize",
      "--copy-metadata",
      "opencv-contrib-python",
      "--copy-metadata",
      "pyclipper",
      "--copy-metadata",
      "pypdfium2",
      "--copy-metadata",
      "python-bidi",
      "--copy-metadata",
      "shapely",
      "src/stirling/medical_redact/sidecar.py",
    ],
    { cwd: ENGINE_DIR, env },
  );

  const pyInstallerOutput = join(distRoot, "medical-redact-engine");
  const builtExecutable = join(pyInstallerOutput, executableName);
  if (!existsSync(builtExecutable)) {
    fail(`PyInstaller output executable is missing: ${builtExecutable}`);
  }

  cpSync(pyInstallerOutput, stagedEngine, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const manifest = {
    schemaVersion: 1,
    bundleVersion,
    engineVersion: bundleVersion,
    apiContractVersion: ENGINE_API_CONTRACT_VERSION,
    platform,
    arch: process.arch,
    executable: executableName,
    packager: {
      name: "PyInstaller",
      version: PYINSTALLER_VERSION,
      mode: "onedir",
    },
  };
  writeFileSync(
    join(stagedEngine, "engine-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  info(`staged Engine at ${stagedEngine}`);
}

function verifyModelManifest(bundleVersion) {
  const manifestPath = join(STAGED_MODELS, "model-manifest.json");
  if (!existsSync(manifestPath)) fail(`missing model manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) fail("unsupported model manifest schema");
  if (manifest.bundleVersion !== bundleVersion) {
    fail(
      `model manifest bundleVersion=${manifest.bundleVersion} does not match app version=${bundleVersion}`,
    );
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    fail("model manifest has no model entries");
  }

  for (const model of manifest.models) {
    if (!Array.isArray(model.files) || model.files.length === 0) {
      fail(`model ${model.id ?? "<unknown>"} has no files`);
    }
    let total = 0;
    for (const file of model.files) {
      const fullPath = join(STAGED_MODELS, file.path);
      if (!existsSync(fullPath)) fail(`model file is missing: ${file.path}`);
      const size = statSync(fullPath).size;
      if (size !== file.size) fail(`model file size mismatch: ${file.path}`);
      if (sha256(fullPath) !== file.sha256) {
        fail(`model file checksum mismatch: ${file.path}`);
      }
      total += size;
    }
    if (total !== model.size) fail(`model size mismatch: ${model.id}`);
    if (modelDigest(model.files) !== model.sha256) {
      fail(`model checksum mismatch: ${model.id}`);
    }
  }
  info(`model manifest verified: ${manifest.models.length} entries`);
}

function verifyPortableSymlinks(root) {
  const resolvedRoot = resolve(root);
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath);
        if (isAbsolute(target)) {
          fail(`Engine staging contains absolute symlink: ${fullPath} -> ${target}`);
        }
        const resolvedTarget = resolve(dirname(fullPath), target);
        const relativeTarget = relative(resolvedRoot, resolvedTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${sep}`) ||
          isAbsolute(relativeTarget)
        ) {
          fail(`Engine staging symlink escapes bundle root: ${fullPath} -> ${target}`);
        }
        if (!existsSync(resolvedTarget)) {
          fail(`Engine staging contains broken symlink: ${fullPath} -> ${target}`);
        }
      } else if (stat.isDirectory()) {
        pending.push(fullPath);
      }
    }
  }
}

function verifyEngineManifest(bundleVersion, platform) {
  const root = join(TAURI_DIR, "medical-engine", platform);
  const manifestPath = join(root, "engine-manifest.json");
  if (!existsSync(manifestPath)) fail(`missing Engine manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) fail("unsupported Engine manifest schema");
  if (manifest.bundleVersion !== bundleVersion) {
    fail(
      `Engine bundleVersion=${manifest.bundleVersion} does not match app version=${bundleVersion}`,
    );
  }
  if (manifest.engineVersion !== bundleVersion) {
    fail(
      `Engine version=${manifest.engineVersion} does not match app version=${bundleVersion}`,
    );
  }
  if (manifest.apiContractVersion !== ENGINE_API_CONTRACT_VERSION) {
    fail(`unsupported Engine API contract version: ${manifest.apiContractVersion}`);
  }
  if (manifest.platform !== platform) {
    fail(`Engine platform=${manifest.platform} does not match target=${platform}`);
  }
  if (manifest.packager?.mode !== "onedir") {
    fail("Engine manifest must declare PyInstaller onedir");
  }
  const executable = join(root, manifest.executable ?? "");
  if (!existsSync(executable)) fail(`Engine executable is missing: ${executable}`);
  if (statSync(executable).size < 1024 * 1024) {
    fail(`Engine executable is suspiciously small: ${executable}`);
  }
  verifyPortableSymlinks(root);
  info(
    `Engine manifest verified: version=${manifest.engineVersion}, platform=${manifest.platform}, arch=${manifest.arch}`,
  );
}

function verifyNoForeignEngineStaging(platform) {
  const root = join(TAURI_DIR, "medical-engine");
  if (!existsSync(root)) return;
  const foreign = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== platform)
    .map((entry) => entry.name);
  if (foreign.length > 0) {
    fail(
      `medical-engine staging contains foreign platform directories for target=${platform}: ${foreign.join(", ")}`,
    );
  }
}

function verifyStaging() {
  const bundleVersion = readBundleVersion();
  const platform = platformName();
  verifyNoForeignEngineStaging(platform);
  verifyEngineManifest(bundleVersion, platform);
  verifyModelManifest(bundleVersion);
}

function printHelp() {
  console.log(`
Medical-redact PyInstaller sidecar builder.

Commands:
  build [--platform=macos|windows]
      Stage verified OCR/NER models, build the medical Engine with PyInstaller
      --onedir, and write Engine/model manifests for the current native OS.

  verify [--platform=macos|windows]
      Verify staged Engine metadata, executable, model files, sizes, and hashes.

The generated frontend/src-tauri/medical-engine and frontend/src-tauri/models
trees are packaging staging only and are not source-controlled.
`);
}

switch (action) {
  case "build": {
    const bundleVersion = readBundleVersion();
    const platform = platformName();
    ensureNativePlatform(platform);
    stageModels(bundleVersion, platform);
    buildEngine(bundleVersion, platform);
    verifyStaging();
    break;
  }
  case "verify":
    verifyStaging();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    fail(`unknown command: ${action}`);
}
