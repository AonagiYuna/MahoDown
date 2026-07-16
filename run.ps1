#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipWebBuild,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$WebDir = Join-Path $Root 'src\editor-web'
$WebDist = Join-Path $WebDir 'dist'
$AppProject = Join-Path $Root 'src\MahoDown.App\MahoDown.App.csproj'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

Write-Host "MahoDown - one-click launch" -ForegroundColor Green

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found." }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw ".NET SDK not found." }

$needWeb = -not $SkipWebBuild -or -not (Test-Path (Join-Path $WebDist 'index.html'))
if ($needWeb) {
    Write-Step "Install and build editor-web"
    Push-Location $WebDir
    try {
        $npmCache = Join-Path $Root '.npm-cache'
        if (-not (Test-Path $npmCache)) { New-Item -ItemType Directory -Path $npmCache | Out-Null }
        npm --cache $npmCache install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Step "Skip editor-web build"
}

Write-Step "Run MahoDown.App ($Configuration | x64)"
dotnet run --project $AppProject -c $Configuration -p:Platform=x64
if ($LASTEXITCODE -ne 0) { throw "dotnet run failed" }
