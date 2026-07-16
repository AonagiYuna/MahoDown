#Requires -Version 5.1
# Build a shareable self-contained folder + zip for friend testing.
[CmdletBinding()]
param(
    [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $Root 'publish\MahoDown-win-x64'
}
$WebDir = Join-Path $Root 'src\editor-web'
$AppProject = Join-Path $Root 'src\MahoDown.App\MahoDown.App.csproj'
$ZipPath = Join-Path $Root 'publish\MahoDown-win-x64.zip'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

Write-Host "MahoDown - package for testing" -ForegroundColor Green

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found." }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw ".NET SDK not found." }

Write-Step "Build editor-web"
Push-Location $WebDir
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally {
    Pop-Location
}

if (Test-Path $OutputDir) {
    Write-Step "Clean $OutputDir"
    Remove-Item -LiteralPath $OutputDir -Recurse -Force
}

Write-Step "dotnet publish (Release | win-x64 | self-contained)"
dotnet publish $AppProject `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:Platform=x64 `
    -p:WindowsAppSDKSelfContained=true `
    -p:WindowsPackageType=None `
    -p:PublishReadyToRun=true `
    -o $OutputDir `
    --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

$pri = Join-Path $OutputDir 'MahoDown.App.pri'
$exe = Join-Path $OutputDir 'MahoDown.App.exe'
$web = Join-Path $OutputDir 'EditorWeb\index.html'
if (-not (Test-Path -LiteralPath $exe)) { throw "Missing $exe" }
if (-not (Test-Path -LiteralPath $web)) { throw "Missing EditorWeb (run npm build first)" }
if (-not (Test-Path -LiteralPath $pri)) {
    # Fallback: copy from intermediate build output
    $fallback = Get-ChildItem -Path (Join-Path $Root 'src\MahoDown.App\bin') -Recurse -Filter 'MahoDown.App.pri' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($fallback) {
        Write-Host "Copying PRI fallback from $($fallback.FullName)" -ForegroundColor Yellow
        Copy-Item -LiteralPath $fallback.FullName -Destination $pri -Force
        Copy-Item -LiteralPath $fallback.FullName -Destination (Join-Path $OutputDir 'resources.pri') -Force
    }
    else {
        throw "Missing MahoDown.App.pri — app will crash on launch without it."
    }
}

Write-Step "Smoke launch (5s)"
$proc = Start-Process -FilePath $exe -WorkingDirectory $OutputDir -PassThru
Start-Sleep -Seconds 5
if ($proc.HasExited) {
    throw "App exited immediately with code $($proc.ExitCode). Package is broken."
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host "Launch OK" -ForegroundColor Green

Write-Step "Zip"
$publishRoot = Split-Path $OutputDir -Parent
if (-not (Test-Path $publishRoot)) { New-Item -ItemType Directory -Path $publishRoot | Out-Null }
if (Test-Path $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -Path (Join-Path $OutputDir '*') -DestinationPath $ZipPath -CompressionLevel Optimal

$sizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Folder : $OutputDir"
Write-Host "  Exe    : $exe"
Write-Host "  Zip    : $ZipPath  ($sizeMb MB)"
Write-Host ""
Write-Host "Friend needs: Windows 10 2004+ / Win11 x64, WebView2 Runtime (usually preinstalled on Win11)."
