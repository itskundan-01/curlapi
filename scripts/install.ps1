<#
    curlapi installer for Windows.

        irm https://raw.githubusercontent.com/itskundan-01/curlapi/main/scripts/install.ps1 | iex

    Written against Windows PowerShell 5.1, which is what ships in the box. None
    of the 7.x-only syntax is used here, so this runs on a clean Windows install
    with nothing added.

    What it does: fetch the application, make sure there is a Node 24 to run it
    with — downloading one only if the machine has none — and put a shortcut in
    the Start Menu. Everything lands under %USERPROFILE%\.curlapi, the same
    directory the tool already keeps its database in. Nothing needs an
    administrator, and nothing is written outside the user's profile.

    Why a script rather than a downloadable installer: a file fetched by
    Invoke-WebRequest carries no mark-of-the-web, so this path has none of the
    SmartScreen warnings an unsigned .exe or .msi would show.
#>

# Stop on the first genuine error rather than carrying on with half an install.
$ErrorActionPreference = 'Stop'

$Repo = 'itskundan-01/curlapi'

# Pinned so that two installs a month apart put the same runtime on disk.
$NodeVersion = '24.19.0'

# Below this there is no node:sqlite and no direct TypeScript execution, which
# are the two things the tool is built on.
$NodeMinimumMajor = 24

$CurlapiHome = if ($env:CURLAPI_HOME) { $env:CURLAPI_HOME } else { Join-Path $env:USERPROFILE '.curlapi' }
$AppDir      = Join-Path $CurlapiHome 'app'
$RuntimeDir  = Join-Path $CurlapiHome 'runtime'
$BinDir      = Join-Path $CurlapiHome 'bin'

# PowerShell 5.1 defaults to TLS 1.0, which nodejs.org and GitHub both refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- output ---------------------------------------------------------------

function Write-Step($message) { Write-Host "-> " -ForegroundColor Cyan -NoNewline; Write-Host $message }
function Write-Note($message) { Write-Host "   $message" -ForegroundColor DarkGray }
function Write-Warn($message) { Write-Host "!  $message" -ForegroundColor Yellow }
# Throws rather than calling exit: this script is normally run as `irm ... | iex`
# inside the user's own session, and `exit` there closes their window rather than
# stopping the install.
function Stop-Install($message) {
    Write-Host ""
    Write-Host "error " -ForegroundColor Red -NoNewline
    Write-Host $message
    throw 'curlapi install did not finish'
}

# --- platform -------------------------------------------------------------

function Get-Architecture {
    # PROCESSOR_ARCHITECTURE reports the *process* architecture, which is x86
    # when a 32-bit PowerShell runs on a 64-bit machine. The OS-level value is
    # the one that decides which Node build to fetch.
    $arch = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
    switch ($arch) {
        9  { return 'x64' }    # x86-64
        12 { return 'arm64' }  # ARM64
        default {
            if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
            Stop-Install "curlapi needs a 64-bit version of Windows; prebuilt Node runtimes are published for x64 and arm64 only."
        }
    }
}

# --- downloading ----------------------------------------------------------

function Get-File($url, $destination) {
    try {
        # The progress bar makes Invoke-WebRequest an order of magnitude slower
        # on large files, and this fetches a 35 MB runtime.
        $previous = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
        $ProgressPreference = $previous
    } catch {
        Stop-Install "Could not download $url`n  $($_.Exception.Message)"
    }
}

function Get-Text($url) {
    try {
        $previous = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        $result = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
        $ProgressPreference = $previous
        return $result
    } catch {
        return $null
    }
}

function Assert-Checksum($file, $expected, $label) {
    $actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        Stop-Install "Checksum mismatch on $label.`n  expected  $expected`n  got       $actual`nRefusing to install it. Try again, and if it repeats, open an issue."
    }
}

# --- the application ------------------------------------------------------

function Resolve-Version {
    if ($env:CURLAPI_VERSION) { return $env:CURLAPI_VERSION }
    # The full list, not /releases/latest: that endpoint skips prereleases, so
    # during beta it reports nothing for a repo that plainly has a release. The
    # list is newest-first, so the first tag is the one to install.
    $json = Get-Text "https://api.github.com/repos/$Repo/releases"
    if (-not $json) {
        Stop-Install "Could not work out the latest curlapi version from GitHub.`nSet one explicitly:  `$env:CURLAPI_VERSION='0.2.0-beta.1'; irm ... | iex"
    }
    if ($json -match '"tag_name"\s*:\s*"v?([^"]+)"') { return $Matches[1] }
    Stop-Install "GitHub published no releases for $Repo yet."
}

function Install-App {
    $staging = Join-Path $CurlapiHome '.staging-app'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    if ($env:CURLAPI_INSTALL_FROM) {
        # Escape hatch for developing the installer: take the payload from a
        # local zip instead of a published release.
        Write-Step "Installing from $env:CURLAPI_INSTALL_FROM"
        Expand-Archive -Path $env:CURLAPI_INSTALL_FROM -DestinationPath $staging -Force
    } else {
        $script:Version = Resolve-Version
        Write-Step "Fetching curlapi $script:Version"

        $name    = "curlapi-$script:Version-app.zip"
        $base    = "https://github.com/$Repo/releases/download/v$script:Version"
        $archive = Join-Path $CurlapiHome ".$name"

        Get-File "$base/$name" $archive

        $sums = Get-Text "$base/SHA256SUMS"
        if ($sums) {
            $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
            if ($line) { Assert-Checksum $archive ($line -split '\s+')[0] "the curlapi payload" }
        } else {
            Write-Warn "No SHA256SUMS published for this release; skipping verification."
        }

        Expand-Archive -Path $archive -DestinationPath $staging -Force
        Remove-Item $archive -Force
    }

    if (-not (Test-Path (Join-Path $staging 'src\cli.ts'))) {
        Stop-Install "The downloaded payload is missing src\cli.ts - it is not a curlapi build."
    }

    if (-not $script:Version) {
        $manifest = Get-Content (Join-Path $staging 'package.json') -Raw | ConvertFrom-Json
        $script:Version = $manifest.version
    }

    # Swap rather than overwrite, so an interrupted extraction cannot leave a
    # half-replaced installation that starts and then fails somewhere deeper.
    $old = "$AppDir.old"
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    if (Test-Path $AppDir) { Move-Item $AppDir $old }
    Move-Item $staging $AppDir
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
}

# --- the runtime ----------------------------------------------------------

function Get-NodeMajor($nodeExe) {
    # Asking Node itself, rather than parsing a version string that may carry a
    # distribution suffix.
    try {
        $out = & $nodeExe -p 'process.versions.node.split(".")[0]' 2>$null
        return [int]$out
    } catch { return 0 }
}

function Install-Runtime {
    $bundled = Join-Path $RuntimeDir 'node.exe'
    if ((Test-Path $bundled) -and (Get-NodeMajor $bundled) -ge $NodeMinimumMajor) {
        Write-Step "Using the Node runtime already in $RuntimeDir"
        $script:NodePath = $bundled
        $script:RuntimeKind = 'bundled'
        return
    }

    $system = Get-Command node -ErrorAction SilentlyContinue
    if ($system) {
        $have = Get-NodeMajor $system.Source
        if ($have -ge $NodeMinimumMajor) {
            Write-Step "Using the Node $have already on this machine"
            $script:NodePath = $system.Source
            $script:RuntimeKind = 'system'
            return
        }
        Write-Note "Node $have is installed but curlapi needs $NodeMinimumMajor or newer."
    }

    $arch = Get-Architecture
    Write-Step "Downloading Node $NodeVersion (about 35 MB, once)"

    $name    = "node-v$NodeVersion-win-$arch.zip"
    $archive = Join-Path $CurlapiHome ".$name"
    Get-File "https://nodejs.org/dist/v$NodeVersion/$name" $archive

    $sums = Get-Text "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
    if ($sums) {
        $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($name))\s*$" } | Select-Object -First 1
        if ($line) { Assert-Checksum $archive ($line -split '\s+')[0] "the Node runtime" }
    } else {
        Write-Warn "Could not fetch Node's checksums; skipping verification."
    }

    $staging = Join-Path $CurlapiHome '.staging-runtime'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    Expand-Archive -Path $archive -DestinationPath $staging -Force
    Remove-Item $archive -Force

    # The official zip wraps everything in a node-vX.Y.Z-win-arch directory.
    $inner = Get-ChildItem $staging -Directory | Select-Object -First 1
    if (-not $inner) { Stop-Install "The extracted Node archive had no directory in it." }

    if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
    Move-Item $inner.FullName $RuntimeDir
    Remove-Item $staging -Recurse -Force

    # npm and the headers exist to build things. curlapi has no build step and no
    # native modules, so dropping them saves about 60 MB of the install.
    foreach ($extra in 'node_modules', 'include') {
        $path = Join-Path $RuntimeDir $extra
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }
    foreach ($extra in 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd') {
        $path = Join-Path $RuntimeDir $extra
        if (Test-Path $path) { Remove-Item $path -Force }
    }

    $script:NodePath = Join-Path $RuntimeDir 'node.exe'
    $script:RuntimeKind = 'bundled'
}

# --- the launcher ---------------------------------------------------------

function Write-Shim {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    # The bundled runtime wins when there is one: it is the version this install
    # was tested against, and a system update cannot change it underneath us.
    # The path chosen at install time is the fallback.
    $cmd = @"
@echo off
rem Generated by the curlapi installer. Regenerated on every install, so edits
rem made here are lost.
setlocal
if not defined CURLAPI_HOME set "CURLAPI_HOME=$CurlapiHome"
set "NODE=%CURLAPI_HOME%\runtime\node.exe"
if not exist "%NODE%" set "NODE=$script:NodePath"
if not exist "%NODE%" (
  echo curlapi cannot find a Node $NodeMinimumMajor runtime. Reinstall to fetch one:
  echo   irm https://raw.githubusercontent.com/$Repo/main/scripts/install.ps1 ^| iex
  exit /b 1
)
"%NODE%" "%CURLAPI_HOME%\app\src\cli.ts" %*
"@
    Set-Content -Path (Join-Path $BinDir 'curlapi.cmd') -Value $cmd -Encoding ASCII

    # Started from a shortcut, a .cmd would flash a console window before the
    # real window appears. wscript running this with a hidden window does not.
    $vbs = @"
' Generated by the curlapi installer. Starts the workspace with no console.
Set shell = CreateObject("WScript.Shell")
shell.Run """$BinDir\curlapi.cmd"" app", 0, False
"@
    Set-Content -Path (Join-Path $BinDir 'curlapi-app.vbs') -Value $vbs -Encoding ASCII
}

function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }

    if (($userPath -split ';') -contains $BinDir) {
        $script:PathAlready = $true
        return
    }

    $updated = if ($userPath.TrimEnd(';')) { "$($userPath.TrimEnd(';'));$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')

    # So `curlapi` works in the session that ran the installer, not only in ones
    # started afterwards.
    $env:Path = "$env:Path;$BinDir"
}

function Add-Shortcut {
    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    New-Item -ItemType Directory -Path $programs -Force | Out-Null

    $link = Join-Path $programs 'curlapi.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = """$BinDir\curlapi-app.vbs"""
    $shortcut.WorkingDirectory = $CurlapiHome
    $shortcut.Description = 'A local workspace of API utilities'

    $icon = Join-Path $AppDir 'assets\curlapi.ico'
    if (Test-Path $icon) { $shortcut.IconLocation = $icon }

    $shortcut.Save()
    $script:ShortcutPath = $link
}

# --- run ------------------------------------------------------------------

$script:Version = $null
$script:NodePath = $null
$script:RuntimeKind = $null
$script:ShortcutPath = $null
$script:PathAlready = $false

Write-Host ""
Write-Host "curlapi" -ForegroundColor White
Write-Host "a local workspace of API utilities" -ForegroundColor DarkGray
Write-Host ""

New-Item -ItemType Directory -Path $CurlapiHome -Force | Out-Null

Install-App
Install-Runtime
Write-Shim
Add-ToPath

Write-Step "Registering the app"
Add-Shortcut

$runtimeLabel = if ($script:RuntimeKind -eq 'bundled') { "bundled Node $NodeVersion" } else { 'the Node already on this machine' }

Write-Host ""
Write-Host "Installed curlapi $script:Version" -ForegroundColor White
Write-Host ""
Write-Host "  Command      curlapi"
Write-Host "  Application  $script:ShortcutPath"
Write-Host "  Runtime      $runtimeLabel"
Write-Host "  Data         $CurlapiHome"
Write-Host ""
Write-Host "Open it from the Start Menu, or run " -NoNewline
Write-Host "curlapi" -ForegroundColor White -NoNewline
Write-Host " in a new terminal."
Write-Host ""
