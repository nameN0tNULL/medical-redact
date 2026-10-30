#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const TAURI_DIR = join(ROOT, "frontend", "src-tauri");
const LIB_DIR = join(TAURI_DIR, "libs");
const JRE_DIR = join(TAURI_DIR, "runtime", "jre");
const TAURI_CONFIG = join(TAURI_DIR, "tauri.conf.json");
const VERSION_FILE = join(
  ROOT,
  "app",
  "common",
  "src",
  "main",
  "resources",
  "version.properties",
);
const REQUIRED_JAVA = 25;
const MAC_ENGINE_SIGNER = join(ROOT, "scripts", "medical-redact", "sign-macos-engine.mjs");

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
  console.error(`[medical-redact-package] FATAL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[medical-redact-package] ${message}`);
}

function warn(message) {
  console.warn(`[medical-redact-package] WARNING: ${message}`);
}

function readVersion() {
  if (!existsSync(VERSION_FILE)) {
    fail(`missing ${VERSION_FILE}`);
  }
  const match = readFileSync(VERSION_FILE, "utf8").match(/^version=(.+)$/m);
  if (!match) fail("version.properties has no version= entry");
  return match[1].trim();
}

function javaMajor(javaHome) {
  if (!javaHome) return 0;
  const executable = join(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  if (!existsSync(executable)) return 0;
  const probe = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    env: process.env,
  });
  const raw = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const match = raw.match(/version\s+"([0-9]+)/);
  return match ? Number(match[1]) : 0;
}

function resolveJava25Env(env) {
  const candidates = [];
  if (env.JAVA_HOME) candidates.push(env.JAVA_HOME);

  if (process.platform === "darwin") {
    const javaHome = spawnSync("/usr/libexec/java_home", ["-v", "25"], {
      encoding: "utf8",
      env,
    });
    if (javaHome.status === 0 && javaHome.stdout.trim()) {
      candidates.push(javaHome.stdout.trim());
    }
    candidates.push("/opt/homebrew/opt/openjdk@25", "/usr/local/opt/openjdk@25");
  }

  for (const candidate of [...new Set(candidates)]) {
    if (javaMajor(candidate) === REQUIRED_JAVA) {
      info(`using JDK ${REQUIRED_JAVA}: ${candidate}`);
      return {
        ...env,
        JAVA_HOME: candidate,
        PATH: `${join(candidate, "bin")}${delimiter}${env.PATH ?? ""}`,
      };
    }
  }

  fail(
    process.platform === "win32"
      ? "JDK 25 is required for desktop packaging; set JAVA_HOME to a JDK 25 installation"
      : "JDK 25 is required for desktop packaging; install openjdk@25 or set JAVA_HOME to JDK 25",
  );
}

function resolveCargoPath(env) {
  const probe = spawnSync(
    process.platform === "win32" ? "where.exe" : "sh",
    process.platform === "win32" ? ["cargo.exe"] : ["-lc", "command -v cargo"],
    { encoding: "utf8", env },
  );
  if (probe.status === 0 && probe.stdout.trim()) {
    return env;
  }

  const rustup = spawnSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
    env,
  });
  if (rustup.status !== 0 || !rustup.stdout.trim()) {
    fail(
      "cargo is not on PATH and rustup could not resolve it; install the Rust stable toolchain",
    );
  }
  const cargoDir = dirname(rustup.stdout.trim());
  info(`cargo not on PATH; using rustup toolchain at ${cargoDir}`);
  return {
    ...env,
    PATH: `${cargoDir}${delimiter}${env.PATH ?? ""}`,
  };
}

function run(command, args, options = {}) {
  info(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    options.onFailure?.();
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    options.onFailure?.();
    fail(`${command} exited with code ${result.status}`);
  }
}

function cleanStaging() {
  info("removing generated desktop JAR/JRE staging so stale artifacts cannot ship");
  rmSync(LIB_DIR, { recursive: true, force: true });
  rmSync(JRE_DIR, { recursive: true, force: true });
}

function verifyPrepared({ requireEngine = false } = {}) {
  const version = readVersion();
  const tauriVersion = JSON.parse(readFileSync(TAURI_CONFIG, "utf8")).version;
  if (tauriVersion !== version) {
    fail(`Tauri version=${tauriVersion} does not match backend version=${version}`);
  }
  const jar = join(LIB_DIR, `stirling-pdf-${version}.jar`);
  if (!existsSync(jar)) fail(`expected staged backend JAR: ${jar}`);

  const jars = existsSync(LIB_DIR)
    ? readdirSync(LIB_DIR).filter((name) => /^stirling-pdf-.*\.jar$/.test(name))
    : [];
  if (jars.length !== 1 || jars[0] !== `stirling-pdf-${version}.jar`) {
    fail(`expected exactly one staged backend JAR for ${version}; found: ${jars.join(", ")}`);
  }
  if (statSync(jar).size < 1024 * 1024) {
    fail(`backend JAR is suspiciously small: ${jar}`);
  }

  const releaseFile = join(JRE_DIR, "release");
  if (!existsSync(releaseFile)) fail(`missing bundled JRE release file: ${releaseFile}`);
  const javaMatch = readFileSync(releaseFile, "utf8").match(/JAVA_VERSION="?([0-9]+)/);
  const javaMajor = javaMatch ? Number(javaMatch[1]) : 0;
  if (!javaMajor || javaMajor < REQUIRED_JAVA) {
    fail(`bundled JRE is Java ${javaMajor || "unknown"}; required >= ${REQUIRED_JAVA}`);
  }

  const engineRoot = join(TAURI_DIR, "medical-engine", platformName());
  if (requireEngine && !existsSync(engineRoot)) {
    fail(
      `full offline release requires packaged medical AI Engine at ${engineRoot}; complete P3.4 first`,
    );
  }
  if (requireEngine) {
    run(
      process.execPath,
      [
        join(ROOT, "scripts", "medical-redact", "build-engine-sidecar.mjs"),
        "verify",
        `--platform=${platformName()}`,
      ],
    );
  }
  if (!existsSync(engineRoot)) {
    warn(
      "medical AI Engine is not bundled yet; this is a P2 validation shell and OCR/PII requires an external local Engine",
    );
  }

  info(
    `preflight OK: version=${version}, backendJar=${jars[0]}, bundledJava=${javaMajor}, platform=${platformName()}`,
  );
}

function cleanupStaleMacDmgState() {
  if (process.platform !== "darwin") return;
  const macBundleDir = join(TAURI_DIR, "target", "release", "bundle", "macos");
  if (!existsSync(macBundleDir)) return;

  const infoProbe = spawnSync("hdiutil", ["info", "-plist"], { encoding: "utf8" });
  if (infoProbe.status !== 0) {
    fail(`failed to inspect mounted disk images: ${infoProbe.stderr || infoProbe.stdout}`);
  }
  const jsonProbe = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: infoProbe.stdout,
  });
  if (jsonProbe.status !== 0) {
    fail(`failed to parse hdiutil state: ${jsonProbe.stderr || jsonProbe.stdout}`);
  }

  const images = JSON.parse(jsonProbe.stdout).images ?? [];
  for (const image of images) {
    const imagePath = image["image-path"] ? resolve(image["image-path"]) : null;
    if (!imagePath) continue;
    const relativeImage = relative(macBundleDir, imagePath);
    if (
      relativeImage.startsWith(`..${sep}`) ||
      isAbsolute(relativeImage) ||
      !relativeImage.startsWith("rw.") ||
      !relativeImage.endsWith(".dmg")
    ) {
      continue;
    }
    const device = (image["system-entities"] ?? [])
      .map((entity) => entity["dev-entry"])
      .find((entry) => /^\/dev\/disk\d+$/.test(entry ?? ""));
    if (!device) continue;
    info(`detaching stale project DMG mount ${device}: ${relativeImage}`);
    const detach = spawnSync("hdiutil", ["detach", device], { encoding: "utf8" });
    if (detach.status !== 0) {
      fail(`failed to detach stale project DMG ${device}: ${detach.stderr || detach.stdout}`);
    }
  }

  for (const name of readdirSync(macBundleDir)) {
    if (name.startsWith("rw.") && name.endsWith(".dmg")) {
      info(`removing stale project DMG temporary image: ${name}`);
      rmSync(join(macBundleDir, name), { force: true });
    }
  }
}

function verifyPortableSymlinks(root, label) {
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
          fail(`${label} contains absolute symlink: ${fullPath} -> ${target}`);
        }
        const resolvedTarget = resolve(dirname(fullPath), target);
        const relativeTarget = relative(resolvedRoot, resolvedTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${sep}`) ||
          isAbsolute(relativeTarget)
        ) {
          fail(`${label} symlink escapes bundle root: ${fullPath} -> ${target}`);
        }
        if (!existsSync(resolvedTarget)) {
          fail(`${label} contains broken symlink: ${fullPath} -> ${target}`);
        }
      } else if (stat.isDirectory()) {
        pending.push(fullPath);
      }
    }
  }
}

function verifyMacAppResources(app) {
  const version = readVersion();
  const resources = join(app, "Contents", "Resources");
  const jar = join(resources, "libs", `stirling-pdf-${version}.jar`);
  const releaseFile = join(resources, "runtime", "jre", "release");
  const engineRoot = join(resources, "medical-engine", "macos");
  const engineManifestPath = join(engineRoot, "engine-manifest.json");
  const modelManifestPath = join(resources, "models", "model-manifest.json");

  for (const required of [jar, releaseFile, engineManifestPath, modelManifestPath]) {
    if (!existsSync(required)) fail(`macOS app is missing required offline resource: ${required}`);
  }

  const release = readFileSync(releaseFile, "utf8");
  const javaMatch = release.match(/JAVA_VERSION="?([0-9]+)/);
  const javaMajor = javaMatch ? Number(javaMatch[1]) : 0;
  if (javaMajor < REQUIRED_JAVA || !release.includes("jdk.management")) {
    fail(`macOS app bundled JRE is incomplete: Java=${javaMajor}, jdk.management required`);
  }

  const engineManifest = JSON.parse(readFileSync(engineManifestPath, "utf8"));
  if (
    engineManifest.bundleVersion !== version ||
    engineManifest.engineVersion !== version ||
    engineManifest.platform !== "macos"
  ) {
    fail(`macOS app Engine manifest does not match release ${version}`);
  }
  const engineExecutable = join(engineRoot, engineManifest.executable ?? "");
  if (!existsSync(engineExecutable)) fail(`macOS app Engine executable is missing: ${engineExecutable}`);

  const modelManifest = JSON.parse(readFileSync(modelManifestPath, "utf8"));
  if (modelManifest.schemaVersion !== 1 || modelManifest.bundleVersion !== version) {
    fail(`macOS app model manifest does not match release ${version}`);
  }

  verifyPortableSymlinks(engineRoot, "macOS bundled Engine");

  const archProbe = spawnSync("lipo", ["-archs", engineExecutable], { encoding: "utf8" });
  if (archProbe.status !== 0 || !archProbe.stdout.trim().split(/\s+/).includes("arm64")) {
    fail(`macOS bundled Engine is not arm64: ${archProbe.stderr || archProbe.stdout}`);
  }
  info(
    `macOS offline resources verified: app=${version}, JRE=${javaMajor}, Engine=${engineManifest.engineVersion}/${engineManifest.arch}, models=${modelManifest.models.length}`,
  );
}

function verifyArtifacts() {
  const platform = platformName();
  const bundleRoot = join(TAURI_DIR, "target", "release", "bundle");
  if (platform === "macos") {
    const app = join(bundleRoot, "macos", "中文医疗资料自动脱敏.app");
    if (!existsSync(app)) fail(`missing macOS app bundle: ${app}`);
    verifyMacAppResources(app);
    info(`macOS app: ${app}`);
    const dmgDir = join(bundleRoot, "dmg");
    const dmgs = existsSync(dmgDir)
      ? readdirSync(dmgDir).filter((name) => name.endsWith(".dmg"))
      : [];
    if (dmgs.length === 0) fail(`missing macOS dmg below ${dmgDir}`);
    for (const name of dmgs) info(`macOS dmg: ${join(dmgDir, name)}`);
    return;
  }
  if (platform === "windows") {
    const nsisDir = join(bundleRoot, "nsis");
    const msiDir = join(bundleRoot, "msi");
    const artifacts = [];
    if (existsSync(nsisDir)) {
      artifacts.push(
        ...readdirSync(nsisDir)
          .filter((name) => name.endsWith(".exe"))
          .map((name) => join(nsisDir, name)),
      );
    }
    if (existsSync(msiDir)) {
      artifacts.push(
        ...readdirSync(msiDir)
          .filter((name) => name.endsWith(".msi"))
          .map((name) => join(msiDir, name)),
      );
    }
    if (artifacts.length === 0) {
      fail(`no Windows installer found below ${bundleRoot}`);
    }
    artifacts.forEach((artifact) => info(`Windows installer: ${artifact}`));
    return;
  }
  fail(`unsupported packaging platform: ${platform}`);
}

function validationBuild() {
  const platform = platformName();
  if (
    (platform === "macos" && process.platform !== "darwin") ||
    (platform === "windows" && process.platform !== "win32")
  ) {
    fail(
      `${platform} validation package must be built on the native OS; cross-platform Tauri packaging is intentionally unsupported`,
    );
  }

  cleanStaging();
  const javaEnv = resolveJava25Env({ ...process.env });
  run(process.platform === "win32" ? "task.exe" : "task", ["desktop:prepare"], { env: javaEnv });
  verifyPrepared({ requireEngine: true });

  const env = resolveCargoPath(javaEnv);
  const bundles = platform === "macos" ? "app,dmg" : "nsis,msi";
  if (platform === "macos") cleanupStaleMacDmgState();
  const buildEnv = platform === "macos" ? { ...env, CI: "true" } : env;
  run(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "tauri",
      "build",
      "--bundles",
      bundles,
      "--no-sign",
      "--config",
      '{"bundle":{"createUpdaterArtifacts":false}}',
    ],
    {
      cwd: join(ROOT, "frontend"),
      env: buildEnv,
      onFailure: platform === "macos" ? cleanupStaleMacDmgState : undefined,
    },
  );
  verifyArtifacts();
}

function printHelp() {
  console.log(`
Canonical medical-redact desktop packaging helper.

Commands:
  validation [--platform=macos|windows]
      Clean generated JAR/JRE staging, rebuild the current backend and JRE,
      build an unsigned native installer for manual validation, then verify
      the expected artifacts.

  preflight [--platform=macos|windows]
      Verify exactly one current backend JAR and a Java 25+ bundled runtime.

  release-preflight [--platform=macos|windows]
      Same as preflight, but also requires the packaged medical AI Engine.
      This is the gate for P3.4+ full offline release builds.

  verify [--platform=macos|windows]
      Verify expected Tauri bundle artifacts exist.

Do not use bare 'tauri build' for the medical client. Use the Task targets
that wrap this script so stale JAR/JRE artifacts cannot be shipped.
`);
}

switch (action) {
  case "validation":
    validationBuild();
    break;
  case "preflight":
    verifyPrepared({ requireEngine: false });
    break;
  case "release-preflight":
    verifyPrepared({ requireEngine: true });
    break;
  case "verify":
    verifyArtifacts();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    fail(`unknown command: ${action}`);
}
