param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

function Info([string]$Message) {
    Write-Host "[medical-redact-windows] $Message"
}

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command '$Name' is not available on PATH."
    }
    return $command
}

function Get-JavaMajor([string]$JavaHome) {
    if ([string]::IsNullOrWhiteSpace($JavaHome)) {
        return 0
    }
    $java = Join-Path $JavaHome "bin\java.exe"
    if (-not (Test-Path $java)) {
        return 0
    }
    $raw = (& $java -version 2>&1 | Out-String)
    $match = [regex]::Match($raw, 'version\s+"([0-9]+)')
    if (-not $match.Success) {
        return 0
    }
    return [int]$match.Groups[1].Value
}

$isNativeWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isNativeWindows) {
    throw "Windows Full Offline package must be built on native Windows."
}

$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($osArch -ne "X64") {
    throw "Windows 11 x64 is the supported first-release target; current OS architecture is $osArch."
}

Require-Command "node.exe" | Out-Null
Require-Command "npm.cmd" | Out-Null
Require-Command "task.exe" | Out-Null
Require-Command "uv.exe" | Out-Null
Require-Command "rustup.exe" | Out-Null

$javaMajor = Get-JavaMajor $env:JAVA_HOME
if ($javaMajor -ne 25) {
    throw "JDK 25 is required. Set JAVA_HOME to a Windows x64 JDK 25 installation before building."
}
Info "JDK 25 verified at $env:JAVA_HOME"

$cargo = (& rustup.exe which cargo 2>$null | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($cargo) -or -not (Test-Path $cargo)) {
    throw "Rust stable toolchain is required; rustup could not resolve cargo."
}
$cargoDir = Split-Path -Parent $cargo
if (-not (($env:PATH -split ';') -contains $cargoDir)) {
    $env:PATH = "$cargoDir;$env:PATH"
}
Info "Rust cargo resolved at $cargo"

$versionFile = Join-Path $Root "app\common\src\main\resources\version.properties"
$versionMatch = [regex]::Match((Get-Content $versionFile -Raw), '(?m)^version=(.+)$')
if (-not $versionMatch.Success) {
    throw "Unable to read application version from $versionFile"
}
$version = $versionMatch.Groups[1].Value.Trim()

$modelCache = Join-Path $Root ".cache\medical-redact\models"
$modelMarker = Join-Path $modelCache "PP-OCRv6_small_rec_infer\inference.onnx"
$stagedModels = Join-Path $Root "frontend\src-tauri\models\paddleocr"

if (-not (Test-Path $modelMarker)) {
    $stagedMarker = Join-Path $stagedModels "PP-OCRv6_small_rec_infer\inference.onnx"
    if (Test-Path $stagedMarker) {
        Info "Restoring host-neutral OCR model cache from existing staged models"
        New-Item -ItemType Directory -Force -Path $modelCache | Out-Null
        Copy-Item -Recurse -Force (Join-Path $stagedModels "*") $modelCache
    }
}

if (-not (Test-Path $modelMarker)) {
    Info "OCR model cache is missing; preparing locked Python environment and downloading models"
    Push-Location (Join-Path $Root "engine")
    try {
        & uv.exe sync --locked --group engine --group engine-package
        if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }

        $python = Join-Path $Root "engine\.venv\Scripts\python.exe"
        & $python "scripts\download_medical_redact_ocr_models.py"
        if ($LASTEXITCODE -ne 0) { throw "OCR model download failed with exit code $LASTEXITCODE" }

        & $python "scripts\convert_medical_redact_ocr_models_to_onnx.py"
        if ($LASTEXITCODE -ne 0) { throw "OCR ONNX conversion failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $modelMarker)) {
    throw "OCR model preparation did not produce $modelMarker"
}

if (-not $SkipTests) {
    Info "Running medical Engine regression suite"
    Push-Location (Join-Path $Root "engine")
    try {
        & uv.exe run --group engine-dev ruff check src\stirling\medical_redact tests\medical_redact
        if ($LASTEXITCODE -ne 0) { throw "Engine lint failed with exit code $LASTEXITCODE" }

        & uv.exe run --group engine-dev pytest -q tests\medical_redact
        if ($LASTEXITCODE -ne 0) { throw "Engine medical-redact tests failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

Info "Building native Windows x64 Medical AI Engine"
& task.exe "medical-redact:engine:package"
if ($LASTEXITCODE -ne 0) { throw "Medical Engine packaging failed with exit code $LASTEXITCODE" }

Info "Building Full Offline Windows NSIS + MSI package"
& task.exe "medical-redact:package:windows:validation"
if ($LASTEXITCODE -ne 0) { throw "Windows desktop packaging failed with exit code $LASTEXITCODE" }

Info "Verifying Windows package artifacts"
& task.exe "medical-redact:package:verify"
if ($LASTEXITCODE -ne 0) { throw "Windows package verification failed with exit code $LASTEXITCODE" }

$bundleRoot = Join-Path $Root "frontend\src-tauri\target\release\bundle"
$nsisArtifacts = @(
    Get-ChildItem (Join-Path $bundleRoot "nsis") -Filter "*.exe" -File -ErrorAction SilentlyContinue
)
$msiArtifacts = @(
    Get-ChildItem (Join-Path $bundleRoot "msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue
)
$artifacts = @($nsisArtifacts + $msiArtifacts)
if ($artifacts.Count -eq 0) {
    throw "No Windows installer artifacts were produced under $bundleRoot"
}
if ($nsisArtifacts.Count -ne 1 -or $msiArtifacts.Count -ne 1) {
    throw (
        "Full Windows validation requires exactly one NSIS .exe and one MSI; found NSIS={0}, MSI={1}." -f
        $nsisArtifacts.Count,
        $msiArtifacts.Count
    )
}

$expectedNsis = Join-Path $nsisArtifacts[0].DirectoryName "中文医疗资料自动脱敏-$version-windows-x64-setup.exe"
$expectedMsi = Join-Path $msiArtifacts[0].DirectoryName "中文医疗资料自动脱敏-$version-windows-x64.msi"
if ($nsisArtifacts[0].FullName -ne $expectedNsis) {
    if (Test-Path $expectedNsis) { Remove-Item -Force $expectedNsis }
    Move-Item -Force $nsisArtifacts[0].FullName $expectedNsis
}
if ($msiArtifacts[0].FullName -ne $expectedMsi) {
    if (Test-Path $expectedMsi) { Remove-Item -Force $expectedMsi }
    Move-Item -Force $msiArtifacts[0].FullName $expectedMsi
}
$nsisArtifacts = @(Get-Item $expectedNsis)
$msiArtifacts = @(Get-Item $expectedMsi)
$artifacts = @($nsisArtifacts + $msiArtifacts)

$extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("medical-redact-msi-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
try {
    Info "Extracting MSI administrative image for offline-resource verification"
    $msi = $msiArtifacts[0].FullName
    $msiArgs = @("/a", ('"{0}"' -f $msi), "/qn", ('TARGETDIR="{0}"' -f $extractRoot))
    $msiProcess = Start-Process "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
    if ($msiProcess.ExitCode -ne 0) {
        throw "MSI administrative extraction failed with exit code $($msiProcess.ExitCode)"
    }

    $jar = Get-ChildItem $extractRoot -Recurse -Filter "stirling-pdf-$version.jar" -File | Select-Object -First 1
    $java = Get-ChildItem $extractRoot -Recurse -Filter "java.exe" -File |
        Where-Object { $_.FullName -match '[\\/]runtime[\\/]jre[\\/]bin[\\/]java\.exe$' } |
        Select-Object -First 1
    $engineExe = Get-ChildItem $extractRoot -Recurse -Filter "medical-redact-engine.exe" -File | Select-Object -First 1
    $engineManifest = Get-ChildItem $extractRoot -Recurse -Filter "engine-manifest.json" -File | Select-Object -First 1

    $modelManifest = $null
    foreach ($candidate in Get-ChildItem $extractRoot -Recurse -Filter "model-manifest.json" -File) {
        try {
            $parsed = Get-Content $candidate.FullName -Raw | ConvertFrom-Json
            if ($parsed.bundleVersion -eq $version -and $parsed.models.Count -ge 5) {
                $modelManifest = $candidate
                break
            }
        }
        catch {
            continue
        }
    }

    if (-not $jar) { throw "MSI is missing current backend JAR stirling-pdf-$version.jar" }
    if (-not $java) { throw "MSI is missing bundled runtime/jre/bin/java.exe" }
    if (-not $engineExe) { throw "MSI is missing Windows medical-redact-engine.exe" }
    if (-not $engineManifest) { throw "MSI is missing Engine manifest" }
    if (-not $modelManifest) { throw "MSI is missing current model manifest with at least 5 models" }

    $engineMeta = Get-Content $engineManifest.FullName -Raw | ConvertFrom-Json
    if (
        $engineMeta.bundleVersion -ne $version -or
        $engineMeta.engineVersion -ne $version -or
        $engineMeta.platform -ne "windows" -or
        $engineMeta.arch -ne "x64"
    ) {
        throw (
            "MSI Engine manifest mismatch: bundle={0}, engine={1}, platform={2}, arch={3}" -f
            $engineMeta.bundleVersion,
            $engineMeta.engineVersion,
            $engineMeta.platform,
            $engineMeta.arch
        )
    }

    $releaseFile = Get-ChildItem $extractRoot -Recurse -Filter "release" -File |
        Where-Object { $_.FullName -match '[\\/]runtime[\\/]jre[\\/]release$' } |
        Select-Object -First 1
    if (-not $releaseFile) { throw "MSI is missing bundled JRE release metadata" }
    $releaseRaw = Get-Content $releaseFile.FullName -Raw
    $javaVersionMatch = [regex]::Match($releaseRaw, 'JAVA_VERSION="?([0-9]+)')
    if (-not $javaVersionMatch.Success -or [int]$javaVersionMatch.Groups[1].Value -lt 25) {
        throw "MSI bundled JRE is not Java 25+"
    }

    Info "MSI offline resources verified: backend=$version, JRE>=25, Engine=$version/x64, models>=5"
}
finally {
    if (Test-Path $extractRoot) {
        Remove-Item -Recurse -Force $extractRoot
    }
}

Info "Windows Full Offline validation package completed: version=$version"
foreach ($artifact in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 $artifact.FullName).Hash.ToLowerInvariant()
    $sizeMiB = [Math]::Round($artifact.Length / 1MB, 1)
    Write-Host ("ARTIFACT {0} ({1} MiB)" -f $artifact.FullName, $sizeMiB)
    Write-Host ("SHA256  {0}" -f $hash)
}
