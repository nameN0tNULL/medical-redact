# Upstream Baseline

## Repository

- Upstream: https://github.com/Stirling-Tools/Stirling-PDF.git
- Remote name: `upstream`
- Baseline branch: `main`
- Baseline commit: `87d790a30d8c072c7d84041afce3bc84528f1118`
- Nearest tag description: `v3.2.1-12-g87d790a30`
- Baseline commit time: `2026-10-22T23:00:14+01:00`
- Local clone date: `2026-10-23`
- Clone mode: partial clone with `--filter=blob:none`

## Upstream Development Commands

The repository uses Task as the supported command runner.

```bash
task install
task check
task dev
task desktop:dev
task desktop:build
```

Area-specific validation commands:

```bash
task frontend:check
task backend:check
task engine:check
```

Platform-specific desktop smoke builds:

```bash
task desktop:build:dev
task desktop:build:dev:mac
task desktop:build:dev:windows
```

## Required Toolchain

According to the upstream developer documentation at this baseline:

- JDK 25
- Node.js 22+
- npm
- Gradle 9+ through the repository wrapper
- Task
- Rust and Cargo
- Tauri CLI
- uv for the Python engine
- Docker for container workflows

Optional system dependencies include LibreOffice, Tesseract, WeasyPrint, and qpdf.

## Local Environment at Baseline

Observed on the first implementation pass:

- macOS 26.3, arm64
- Node.js 26.8.1
- npm 11.19.0
- uv 0.6.9
- Docker 29.1.3
- Default Java: Temurin 17.0.10
- JDK 25: not installed
- Task: not installed
- Rust/Cargo: not found in PATH

The upstream desktop baseline cannot be considered verified until JDK 25, Task, and Rust/Cargo are available.

## Primary Modification Areas

The medical-redaction client should prefer additive or shadowed changes in these existing areas:

- `frontend/src/editor/desktop/` for desktop-specific UI and behavior
- `frontend/src/editor/core/` for shared workbench/viewer abstractions only when necessary
- `frontend/src-tauri/` for native desktop lifecycle, packaging, and local runtime integration
- `app/core/` and related backend modules for Java APIs and PDF operations
- `engine/src/stirling/` for local OCR/PII/alignment/verification capabilities

The implementation should keep existing PDF viewer, Redact, sanitize, metadata scrub, export, FileContext, and Tauri/JLink infrastructure intact.

## Upstream Sync Notes

- Do not physically delete unrelated Stirling tools during early product trimming.
- Prefer route/tool visibility configuration and desktop-layer overrides so upstream changes remain mergeable.
- Keep normal imports through `@app/*` and follow the repository layer-shadowing model.
- All frontend file handling must continue through FileContext.
- After changing frontend, backend, or engine code, run the corresponding `task <area>:check`.
- Before syncing upstream, review changes in desktop overrides, Tauri configuration, backend API contracts, and engine contracts for conflicts.
