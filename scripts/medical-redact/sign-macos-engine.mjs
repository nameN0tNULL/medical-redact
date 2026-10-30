#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_ENGINE_ROOT = join(
  ROOT,
  "frontend",
  "src-tauri",
  "medical-engine",
  "macos",
);

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const identity =
  args.find((arg) => arg.startsWith("--identity="))?.slice("--identity=".length) ??
  process.env.MEDICAL_REDACT_SIGNING_IDENTITY ??
  process.env.APPLE_SIGNING_IDENTITY;
const engineRoot = resolve(
  args.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) ??
    DEFAULT_ENGINE_ROOT,
);
const timestampNone = args.includes("--timestamp=none");

function fail(message) {
  console.error(`[medical-redact-sign] FATAL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[medical-redact-sign] ${message}`);
}

function command(commandName, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(commandName, commandArgs, {
    encoding: "utf8",
    env: process.env,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail(
      `${commandName} ${commandArgs.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result;
}

function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(fullPath);
      else if (stat.isFile()) files.push(fullPath);
    }
  }
  return files;
}

function isMachO(path) {
  const result = command("file", ["-b", path]);
  return result.stdout.includes("Mach-O");
}

function signatureDetails(path) {
  const result = command("codesign", ["-dv", "--verbose=4", path], {
    allowFailure: true,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function teamId(path) {
  return signatureDetails(path).match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? "";
}

function sign(path, { runtime = false } = {}) {
  const signArgs = ["--force"];
  if (runtime) signArgs.push("--options", "runtime");
  signArgs.push(timestampNone ? "--timestamp=none" : "--timestamp");
  signArgs.push("--sign", identity, path);
  command("codesign", signArgs);
}

if (process.platform !== "darwin") {
  fail("macOS Engine signing must run on macOS");
}
if (!existsSync(engineRoot)) {
  fail(`missing macOS Engine staging: ${engineRoot}`);
}

const manifestPath = join(engineRoot, "engine-manifest.json");
if (!existsSync(manifestPath)) fail(`missing Engine manifest: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.platform !== "macos") {
  fail(`Engine manifest platform must be macos, got ${manifest.platform}`);
}
const executable = join(engineRoot, manifest.executable ?? "medical-redact-engine");
if (!existsSync(executable)) fail(`missing Engine executable: ${executable}`);

const nestedMachO = walkFiles(join(engineRoot, "_internal")).filter(isMachO);
if (nestedMachO.length === 0) fail("Engine contains no nested Mach-O files");

if (!verifyOnly) {
  if (!identity) {
    fail(
      "signing identity is required via --identity=..., MEDICAL_REDACT_SIGNING_IDENTITY, or APPLE_SIGNING_IDENTITY",
    );
  }
  info(`signing ${nestedMachO.length} nested Mach-O files before Engine executable`);
  for (const path of nestedMachO) sign(path);
  sign(executable, { runtime: true });
}

command("codesign", ["--verify", "--strict", "--verbose=4", executable]);
const engineDetails = signatureDetails(executable);
if (!engineDetails.includes("flags=0x10000(runtime)")) {
  fail("Engine executable is not signed with hardened runtime");
}
const expectedTeam = teamId(executable);
if (!expectedTeam || expectedTeam === "not set") {
  fail("Engine executable has no signing TeamIdentifier");
}

const mismatches = [];
for (const path of nestedMachO) {
  const nestedTeam = teamId(path);
  if (nestedTeam !== expectedTeam) {
    mismatches.push(`${path}: ${nestedTeam || "<missing>"}`);
    if (mismatches.length >= 10) break;
  }
}
if (mismatches.length > 0) {
  fail(
    `nested Engine code does not share TeamIdentifier ${expectedTeam}:\n${mismatches.join("\n")}`,
  );
}

info(
  `Engine signing verified: team=${expectedTeam}, hardenedRuntime=true, nestedMachO=${nestedMachO.length}`,
);
