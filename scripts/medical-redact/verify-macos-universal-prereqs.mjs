#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const ENGINE_PYPROJECT = join(ROOT, "engine", "pyproject.toml");
const ENGINE_LOCK = join(ROOT, "engine", "uv.lock");

function fail(message) {
  console.error(`[medical-redact-universal] FATAL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[medical-redact-universal] ${message}`);
}

function probe(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    ...options,
  });
}

const issues = [];

function requireArch(path, arch) {
  const variable = arch === "arm64" ? "AARCH64_JAVA_HOME" : "X64_JAVA_HOME";
  if (!path || !existsSync(join(path, "bin", "java"))) {
    issues.push(`${arch} JDK 25 is missing; set ${variable}`);
    return;
  }
  const java = join(path, "bin", "java");
  const version = probe(java, ["-version"]);
  const rawVersion = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (version.status !== 0 || !/version\s+"25(?:\.|")/.test(rawVersion)) {
    issues.push(`${path} is not a runnable JDK 25`);
    return;
  }
  const archs = probe("lipo", ["-archs", java]);
  if (archs.status !== 0 || !archs.stdout.trim().split(/\s+/).includes(arch)) {
    issues.push(`${path} JDK does not provide ${arch} java`);
    return;
  }
  info(`JDK 25 ${arch}: ${path}`);
}

if (process.platform !== "darwin") fail("universal macOS preflight must run on macOS");

const rosetta = probe("arch", ["-x86_64", "/usr/bin/true"]);
if (rosetta.status !== 0) issues.push("Rosetta 2 is required for the x86_64 build leg");
else info("Rosetta 2: available");

const rustTargets = probe("rustup", ["target", "list", "--installed"]);
if (
  rustTargets.status !== 0 ||
  !rustTargets.stdout.split(/\s+/).includes("aarch64-apple-darwin") ||
  !rustTargets.stdout.split(/\s+/).includes("x86_64-apple-darwin")
) {
  issues.push(
    "Rust targets aarch64-apple-darwin and x86_64-apple-darwin are both required",
  );
} else info("Rust macOS targets: arm64 + x86_64");

requireArch(process.env.AARCH64_JAVA_HOME, "arm64");
requireArch(process.env.X64_JAVA_HOME, "x86_64");

const pyproject = readFileSync(ENGINE_PYPROJECT, "utf8");
const paddleVersion = pyproject.match(/"paddlepaddle==([^"]+)"/)?.[1];
if (!paddleVersion) fail("could not resolve pinned paddlepaddle version");

const lock = readFileSync(ENGINE_LOCK, "utf8");
const paddleBlock = lock.match(
  new RegExp(
    `\\[\\[package\\]\\]\\nname = "paddlepaddle"\\nversion = "${paddleVersion.replaceAll(".", "\\.")}"[\\s\\S]*?(?=\\n\\[\\[package\\]\\]|$)`,
  ),
)?.[0];
if (!paddleBlock) fail(`paddlepaddle ${paddleVersion} is missing from uv.lock`);
const hasMacX64Wheel = /paddlepaddle-[^"\n]*macosx[^"\n]*x86_64\.whl/.test(
  paddleBlock,
);
if (!hasMacX64Wheel) {
  issues.push(
    `paddlepaddle==${paddleVersion} has no macOS x86_64 wheel in uv.lock; universal Full Offline Engine cannot be produced without changing the approved runtime/dependency strategy`,
  );
} else info(`paddlepaddle ${paddleVersion}: macOS x86_64 wheel available`);

if (issues.length > 0) {
  fail(`universal macOS prerequisites are not satisfied:\n- ${issues.join("\n- ")}`);
}
info("universal macOS prerequisites PASS");
