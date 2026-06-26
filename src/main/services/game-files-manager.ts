import { ASSETS_PATH } from "@main/constants";
import { getGameAssets } from "@main/events/catalogue/get-game-assets";
import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import { updateGameExecutablePath } from "@main/helpers/update-executable-path";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import {
  Downloader,
  FILE_EXTENSIONS_TO_EXTRACT,
  removeSymbolsFromName,
} from "@shared";
import type { GameShop, UserPreferences } from "@types";
import axios from "axios";
import createDesktopShortcut from "create-desktop-shortcuts";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import pngToIco from "png-to-ico";
import sharp from "sharp";
import { ExtractionProgress, SevenZip } from "./7zip";
import * as emulators from "./emulators";
import { getPathType } from "./extraction-path";
import { GameExecutables } from "./game-executables";
import { logger } from "./logger";
import { platformToSystem } from "@main/helpers";
import { deleteArchiveFile } from "@main/events/library/delete-archive";
import { publishExtractionCompleteNotification } from "./notifications";
import { SystemPath } from "./system-path";
import { WindowManager } from "./window-manager";

const PROGRESS_THROTTLE_MS = 1000;

// Runs a FitGirl/InnoSetup installer for a clean, game-only silent install.
// The script self-elevates ONCE (single UAC) so everything below runs at the
// same integrity as setup.exe: that lets it mute setup's music and kill the
// file verifier reliably (a non-elevated process cannot touch an elevated one).
// Steps: probe the repack's components via /SAVEINF, drop DirectX/redist-style
// ones, then install with /COMPONENTS while muting audio and killing QuickSFV.
// Exit code is the installer's; a declined UAC resolves to 1223 (ERROR_CANCELLED).
const ELEVATED_INSTALLER_SCRIPT = `
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$ProcessName = 'setup',
  [string]$InstallDir = '',
  [string]$ArgsB64 = ''
)
$ErrorActionPreference = 'Stop'

$baseArgs = ''
if ($ArgsB64) { $baseArgs = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($ArgsB64)) }

$isAdmin = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  # Elevate this whole script once. FitGirl paths contain square brackets, so we
  # build the argument string literally (no Start-Process wildcard expansion).
  try {
    $relArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Exe "' + $Exe + '" -ProcessName "' + $ProcessName + '" -InstallDir "' + $InstallDir + '" -ArgsB64 "' + $ArgsB64 + '"'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = $relArgs
    $psi.UseShellExecute = $true
    $psi.Verb = 'runas'
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $elevated = [System.Diagnostics.Process]::Start($psi)
  } catch {
    exit 1223
  }
  $elevated.WaitForExit()
  try { exit $elevated.ExitCode } catch { exit 0 }
}

# ----- Elevated from here -----
$workDir = Split-Path -Parent $Exe

$muteReady = $false
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace HydraAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public enum EDataFlow { eRender, eCapture, eAll }
  public enum ERole { eConsole, eMultimedia, eCommunications }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator { int N1(); [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow d, ERole r, out IMMDevice ppDevice); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 { int N1(); int N2(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 { int N0(); int N1(); int N2(); int N3(); int N4(); int N5(); int N6(); int N7(); int N8(); int N9(); int N10(); [PreserveSig] int GetProcessId(out uint pid); }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume { int N0(); int N1(); [PreserveSig] int SetMute(bool m, ref Guid ctx); [PreserveSig] int GetMute(out bool m); }
  public static class Mixer {
    static Guid IID = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    public static void MuteByProcessName(string name) {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev; if (en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out dev) != 0) return;
      object mo; if (dev.Activate(ref IID, 23, IntPtr.Zero, out mo) != 0) return;
      var mgr = (IAudioSessionManager2)mo;
      IAudioSessionEnumerator se; if (mgr.GetSessionEnumerator(out se) != 0) return;
      int c; se.GetCount(out c);
      for (int i = 0; i < c; i++) {
        IAudioSessionControl2 ctl; if (se.GetSession(i, out ctl) != 0) continue;
        uint pid; if (ctl.GetProcessId(out pid) == 0) {
          try {
            var p = System.Diagnostics.Process.GetProcessById((int)pid);
            // Match "setup" AND InnoSetup's extracted engine "setup.tmp" (which
            // is the process that actually plays the repack music).
            if (p.ProcessName.StartsWith(name, StringComparison.OrdinalIgnoreCase)) {
              var v = (ISimpleAudioVolume)ctl; Guid g = Guid.Empty; v.SetMute(true, ref g);
            }
          } catch { }
        }
        Marshal.ReleaseComObject(ctl);
      }
    }
  }
}
'@
  $muteReady = $true
} catch { $muteReady = $false }

# Win32 launcher: starts setup.exe via CreateProcess so we can place it (and every
# child it spawns) on a private, non-interactive desktop. DeskProc wraps the process
# handle with the small surface the script needs (HasExited/WaitForExit/ExitCode/
# Kill/Close).
$deskReady = $false
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace HydraLaunch {
  public class DeskProc {
    public int Pid; public IntPtr H;
    public DeskProc(int pid, IntPtr h) { Pid = pid; H = h; }
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    public bool HasExited() { if (H == IntPtr.Zero) return true; return WaitForSingleObject(H, 0) == 0; }
    public void WaitForExit() { if (H != IntPtr.Zero) WaitForSingleObject(H, 0xFFFFFFFF); }
    public int ExitCode() { uint c; if (H != IntPtr.Zero && GetExitCodeProcess(H, out c)) return (int)c; return -1; }
    public void Kill() { try { if (H != IntPtr.Zero) TerminateProcess(H, 1); } catch { } }
    public void Close() { if (H != IntPtr.Zero) { CloseHandle(H); H = IntPtr.Zero; } }
  }
  public static class Launcher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
      public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow;
      public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateDesktop(string name, string device, IntPtr devmode, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern uint AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outBuf, ref uint outLen);
    public static IntPtr MakeDesktop(string name) { return CreateDesktop(name, null, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero); }
    public static void DropDesktop(IntPtr h) { if (h != IntPtr.Zero) CloseDesktop(h); }
    // Resolves the executable that ShellExecute would launch for a URL scheme
    // (e.g. "https") - i.e. the user's actual default browser - via the same
    // association API the shell uses, so it works regardless of how the default
    // is registered (UserChoice, ProgId, protocol key, ...). 2 = ASSOCSTR_EXECUTABLE.
    public static string DefaultBrowserExe(string scheme) {
      uint len = 1024; var sb = new StringBuilder((int)len);
      if (AssocQueryString(0, 2, scheme, "open", sb, ref len) != 0) return "";
      return sb.ToString();
    }
    static bool Try(string app, string cmd, string dir, string desktop, out PROCESS_INFORMATION pi) {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      if (!string.IsNullOrEmpty(desktop)) si.lpDesktop = desktop;
      StringBuilder sb = new StringBuilder(cmd);
      return CreateProcess(app, sb, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, dir, ref si, out pi);
    }
    public static DeskProc Start(string app, string cmd, string dir, string desktop) {
      PROCESS_INFORMATION pi;
      bool ok = Try(app, cmd, dir, desktop, out pi);
      if (!ok && !string.IsNullOrEmpty(desktop)) ok = Try(app, cmd, dir, null, out pi);
      if (!ok) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      return new DeskProc(pi.dwProcessId, pi.hProcess);
    }
  }
}
'@
  $deskReady = $true
} catch { $deskReady = $false }

# Create a private, non-interactive desktop so NONE of the installer's windows ever
# reach the user: the file-verification window, the InnoSetup GUI, the host.cmd
# console, and the post-install browser the repack opens to the FitGirl site all
# render on this invisible desktop (we never SwitchDesktop to it). Audio is muted
# separately since sound is not desktop-bound. If creation fails we fall back to the
# normal desktop and the other mitigations still apply.
$deskName = ''
$hDesk = [IntPtr]::Zero
if ($deskReady) {
  try {
    $deskName = 'HydraInstall' + ([System.Guid]::NewGuid().ToString('N').Substring(0, 8))
    $hDesk = [HydraLaunch.Launcher]::MakeDesktop($deskName)
    if ($hDesk -eq [IntPtr]::Zero) { $deskName = '' }
  } catch { $deskName = ''; $hDesk = [IntPtr]::Zero }
}

function Start-Setup([string]$arguments) {
  $cmd = '"' + $Exe + '" ' + $arguments
  if ($deskReady) {
    return [HydraLaunch.Launcher]::Start($Exe, $cmd, $workDir, $deskName)
  }
  # Fallback: launcher type unavailable -> wrap a .NET process to the same shape.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.WorkingDirectory = $workDir
  $psi.UseShellExecute = $false
  $psi.Arguments = $arguments
  $netProc = [System.Diagnostics.Process]::Start($psi)
  return [PSCustomObject]@{ NetProc = $netProc } |
    Add-Member -PassThru -MemberType ScriptMethod -Name HasExited -Value { $this.NetProc.HasExited } |
    Add-Member -PassThru -MemberType ScriptMethod -Name WaitForExit -Value { $this.NetProc.WaitForExit() } |
    Add-Member -PassThru -MemberType ScriptMethod -Name ExitCode -Value { try { $this.NetProc.ExitCode } catch { -1 } } |
    Add-Member -PassThru -MemberType ScriptMethod -Name Kill -Value { try { $this.NetProc.Kill() } catch { } } |
    Add-Member -PassThru -MemberType ScriptMethod -Name Close -Value { try { $this.NetProc.Dispose() } catch { } }
}

# Backup that closes any browser the installer opens to the FitGirl site, matched by
# the URL in its command line so the user's own windows are left untouched. The browser
# is already blocked deterministically by the URL-association repoint below; this only
# catches a stray launch if that ever misses. IMPORTANT: it must NOT delete anything
# from the is-*.tmp folder - FitGirl's installer integrity-checks those support files
# and aborts the whole install (exit 1, nothing decompressed) if any go missing. The
# host.cmd console and the verification window are hidden by the private desktop instead,
# and host.cmd's hosts-file edits are reverted after the install.
function Invoke-SuppressFitGirlPayload {
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '(?i)^(msedge|chrome|firefox|brave|opera|vivaldi|iexplore)' -and $_.CommandLine -match '(?i)fitgirl' } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  } catch { }
}

# Pass 1: discover the repack's selected components via /SAVEINF (written before
# any files are decompressed), then drop DirectX/redist-style components so only
# the game is installed. The probe is killed as soon as the INF appears.
$components = ''
try {
  $infFile = [System.IO.Path]::Combine($env:TEMP, 'hydra-saveinf.inf')
  if (Test-Path -LiteralPath $infFile) { Remove-Item -LiteralPath $infFile -Force }
  $probeDir = [System.IO.Path]::Combine($env:TEMP, 'hydra-probe')
  $probe = Start-Setup ('/VERYSILENT /SUPPRESSMSGBOXES "/DIR=' + $probeDir + '" /NORESTART /SP- "/SAVEINF=' + $infFile + '"')
  for ($i = 0; $i -lt 300; $i++) {
    if ($muteReady) { try { [HydraAudio.Mixer]::MuteByProcessName($ProcessName) } catch { } }
    Invoke-SuppressFitGirlPayload
    if (Test-Path -LiteralPath $infFile) { break }
    Start-Sleep -Milliseconds 100
  }
  Start-Sleep -Milliseconds 300
  try { if ($probe -and -not $probe.HasExited()) { $probe.Kill() } } catch { }
  # Kill the loader AND the extracted "setup.tmp" engine, then wait until both
  # are gone so the probe's music can't bleed into the real install.
  Get-Process | Where-Object { $_.ProcessName -like 'setup*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($w = 0; $w -lt 24; $w++) {
    if (-not (Get-Process | Where-Object { $_.ProcessName -like 'setup*' })) { break }
    Start-Sleep -Milliseconds 250
  }
  try { if ($probe) { $probe.Close() } } catch { }
  if (Test-Path -LiteralPath $infFile) {
    $line = (Get-Content -LiteralPath $infFile | Where-Object { $_ -match '^Components=' } | Select-Object -First 1)
    if ($line) {
      $all = ($line -replace '^Components=', '').Split(',') | Where-Object { $_ -ne '' }
      $kept = $all | Where-Object { $_ -notmatch '(?i)directx|redist|vcredist|vc_redist|dotnet|visualc|dxsetup' }
      if ($kept) { $components = ($kept -join ',') }
    }
  }
  try { if (Test-Path -LiteralPath $probeDir) { Remove-Item -LiteralPath $probeDir -Recurse -Force } } catch { }
} catch { $components = '' }

# Deterministically blocks the post-install browser pop-up: FitGirl's installer opens
# https://bit.ly/fitgirl-repacks-site via ShellExecute. The hidden desktop only hides a
# freshly launched browser - when one is already running, the URL is handed to that
# instance on the user's real desktop, so a tab still appears. Repointing the registered
# URL handler proved unreliable (modern Windows resolves the default browser through an
# association API, not the classic protocol key). So instead, for the duration of the
# install, we set an Image File Execution Options "Debugger" on the default browser's
# executable: Windows then intercepts every NEW launch of that exe and runs a no-op
# instead, so the installer's ShellExecute opens nothing - regardless of how the default
# browser is registered. The already-running browser is untouched (IFEO only affects new
# launches), and it is fully restored the moment the install ends. We cover the resolved
# default browser plus the common browser executables as a safety net.
$BS = [string][char]92
$ifeoRestore = New-Object System.Collections.ArrayList
function Disable-UrlOpen {
  $ErrorActionPreference = 'SilentlyContinue'
  $noop = '"' + [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'cmd.exe') + '" /c exit'
  $ifeoBase = 'HKLM:' + $BS + 'SOFTWARE' + $BS + 'Microsoft' + $BS + 'Windows NT' + $BS + 'CurrentVersion' + $BS + 'Image File Execution Options'
  $exes = New-Object System.Collections.Generic.HashSet[string]
  foreach ($scheme in @('https', 'http')) {
    try {
      $p = [HydraLaunch.Launcher]::DefaultBrowserExe($scheme)
      if ($p) { $name = [System.IO.Path]::GetFileName($p); if ($name) { [void]$exes.Add($name.ToLower()) } }
    } catch { }
  }
  foreach ($name in @('msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'zen.exe', 'iexplore.exe', 'librewolf.exe')) {
    [void]$exes.Add($name)
  }
  foreach ($exe in $exes) {
    try {
      $key = $ifeoBase + $BS + $exe
      $existed = Test-Path -LiteralPath $key
      $origDbg = $null
      if ($existed) { $origDbg = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).Debugger }
      New-Item -Path $key -Force -ErrorAction SilentlyContinue | Out-Null
      Set-ItemProperty -LiteralPath $key -Name 'Debugger' -Value $noop -ErrorAction SilentlyContinue
      [void]$ifeoRestore.Add([PSCustomObject]@{ Key = $key; Existed = $existed; OrigDbg = $origDbg })
    } catch { }
  }
}
function Restore-UrlOpen {
  $ErrorActionPreference = 'SilentlyContinue'
  foreach ($r in $ifeoRestore) {
    try {
      if ($r.Existed) {
        if ($null -ne $r.OrigDbg) { Set-ItemProperty -LiteralPath $r.Key -Name 'Debugger' -Value $r.OrigDbg }
        else { Remove-ItemProperty -LiteralPath $r.Key -Name 'Debugger' -ErrorAction SilentlyContinue }
      } else {
        Remove-Item -LiteralPath $r.Key -Recurse -Force -ErrorAction SilentlyContinue
      }
    } catch { }
  }
}

# Pass 2: real install (game-only components) while muting setup's audio, killing the
# file verifier (QuickSFV), and neutralizing FitGirl's post-install payload (host.cmd
# hosts-redirection step + the "thank you" browser pop-up). Everything from here is in
# try/finally so the browser association and the private desktop are always restored.
$installArgs = $baseArgs
if ($components) { $installArgs = $installArgs + ' "/COMPONENTS=' + $components + '"' }

$code = 1
Disable-UrlOpen
try {
  $proc = $null
  try { $proc = Start-Setup $installArgs } catch { $proc = $null }

  # Tight opening burst: mute the music and delete the payload every 50ms so the
  # sound is silenced within a few frames (no audible "split second" at the start).
  for ($b = 0; $b -lt 24; $b++) {
    if ($muteReady) { try { [HydraAudio.Mixer]::MuteByProcessName($ProcessName) } catch { } }
    Invoke-SuppressFitGirlPayload
    Start-Sleep -Milliseconds 50
  }
  while ($true) {
    if ($muteReady) { try { [HydraAudio.Mixer]::MuteByProcessName($ProcessName) } catch { } }
    Get-Process | Where-Object { $_.ProcessName -like 'QuickSFV*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Invoke-SuppressFitGirlPayload
    $alive = $false
    if ($proc) { try { if (-not $proc.HasExited()) { $alive = $true } } catch { $alive = $false } }
    if (-not $alive -and (Get-Process | Where-Object { $_.ProcessName -like 'setup*' })) { $alive = $true }
    if (-not $alive) { break }
    Start-Sleep -Milliseconds 500
  }

  # Keep sweeping briefly after the installer is gone so a last-moment payload or
  # browser launch (if the association block ever misses) doesn't slip through.
  for ($s = 0; $s -lt 12; $s++) {
    Invoke-SuppressFitGirlPayload
    Start-Sleep -Milliseconds 250
  }

  # Safety net: if host.cmd still managed to run (e.g. a very fast install beat the
  # deletion), strip the "fake site" FitGirl redirections it adds to the hosts file.
  try {
    $hostsPath = [System.IO.Path]::Combine($env:WINDIR, 'System32', 'drivers', 'etc', 'hosts')
    if (Test-Path -LiteralPath $hostsPath) {
      $orig = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
      $cleaned = @($orig | Where-Object { $_ -notmatch '(?i)fitgirl' })
      if ($cleaned.Count -lt $orig.Count) {
        Set-Content -LiteralPath $hostsPath -Value $cleaned -Encoding ASCII -ErrorAction Stop
      }
    }
  } catch { }

  try { if ($proc -and $proc.HasExited()) { $code = $proc.ExitCode() } } catch { $code = 0 }
  try { if ($proc) { $proc.Close() } } catch { }

  # A relaunched installer can exit non-zero while the real install (in a child)
  # succeeds, so treat a populated target dir as success.
  if ($code -ne 0 -and $InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
    try {
      $sz = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      if ($sz -gt 52428800) { $code = 0 }
    } catch { }
  }
} finally {
  # Always restore the browser association and tear down the private desktop.
  Restore-UrlOpen
  try { if ($hDesk -ne [IntPtr]::Zero) { [HydraLaunch.Launcher]::DropDesktop($hDesk) } } catch { }
}

exit $code
`;

// Runs a single Windows executable elevated (one UAC) and waits for it. Used to
// run a game's InnoSetup uninstaller. A declined UAC resolves to 1223.
const ELEVATED_RUN_SCRIPT = `
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$WorkDir = '',
  [string]$ArgsB64 = ''
)
$ErrorActionPreference = 'Stop'
$arguments = ''
if ($ArgsB64) { $arguments = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($ArgsB64)) }
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
  $psi.UseShellExecute = $true
  $psi.Verb = 'runas'
  if ($arguments) { $psi.Arguments = $arguments }
  $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
  exit 1223
}
$proc.WaitForExit()
try { exit $proc.ExitCode } catch { exit 0 }
`;

export class GameFilesManager {
  private lastProgressUpdateTime = 0;
  private lastProgressUpdateValue = 0;

  constructor(
    private readonly shop: GameShop,
    private readonly objectId: string
  ) {}

  private get gameKey() {
    return levelKeys.game(this.shop, this.objectId);
  }

  private updateExtractionProgress(progress: number, force = false) {
    const now = Date.now();

    if (!force && now - this.lastProgressUpdateTime < PROGRESS_THROTTLE_MS) {
      return;
    }

    if (!force && progress < this.lastProgressUpdateValue) {
      return;
    }

    this.lastProgressUpdateValue = progress;
    this.lastProgressUpdateTime = now;

    WindowManager.sendToAppWindows(
      "on-extraction-progress",
      this.shop,
      this.objectId,
      progress
    );
  }

  private async setExtractionFailedState(error: unknown, targetPath?: string) {
    logger.error(
      `[GameFilesManager] Extraction failed for ${this.objectId}${targetPath ? ` at ${targetPath}` : ""}`,
      error
    );

    const download = await downloadsSublevel.get(this.gameKey);

    if (download) {
      const status =
        download.progress === 1
          ? download.shouldSeed && download.downloader === Downloader.Torrent
            ? "seeding"
            : "complete"
          : download.status;

      await downloadsSublevel.put(this.gameKey, {
        ...download,
        status,
        queued: false,
        extracting: false,
      });
      WindowManager.sendDownloadsUpdated();
    }

    WindowManager.sendToAppWindows(
      "on-extraction-failed",
      this.shop,
      this.objectId
    );

    this.lastProgressUpdateTime = 0;
    this.lastProgressUpdateValue = 0;
  }

  async failExtraction(error: unknown, targetPath?: string) {
    await this.setExtractionFailedState(error, targetPath);
  }

  private readonly handleProgress = (progress: ExtractionProgress) => {
    console.log(`handleProgress: ${progress.percent}% - ${progress.file}`);
    this.updateExtractionProgress(progress.percent / 100);
  };

  async extractFilesInDirectory(directoryPath: string): Promise<boolean> {
    let pathType: Awaited<ReturnType<typeof getPathType>>;
    try {
      pathType = await getPathType(directoryPath);
    } catch (error) {
      await this.setExtractionFailedState(error, directoryPath);
      return false;
    }

    if (pathType !== "directory") {
      await this.setExtractionFailedState(
        new Error(
          `Expected extraction directory but got "${pathType}" for ${directoryPath}`
        ),
        directoryPath
      );
      return false;
    }

    let files: string[];
    try {
      files = await fs.promises.readdir(directoryPath);
    } catch (error) {
      await this.setExtractionFailedState(error, directoryPath);
      return false;
    }

    const compressedFiles = files.filter((file) =>
      FILE_EXTENSIONS_TO_EXTRACT.some((ext) => file.toLowerCase().endsWith(ext))
    );

    const filesToExtract = compressedFiles.filter(
      (file) => /part1\.rar$/i.test(file) || !/part\d+\.rar$/i.test(file)
    );

    if (filesToExtract.length === 0) return true;

    this.updateExtractionProgress(0, true);

    const totalFiles = filesToExtract.length;
    let completedFiles = 0;

    for (const file of filesToExtract) {
      try {
        const result = await SevenZip.extractFile(
          {
            filePath: path.join(directoryPath, file),
            cwd: directoryPath,
            passwords: ["online-fix.me", "steamrip.com"],
          },
          (progress) => {
            const overallProgress =
              (completedFiles + progress.percent / 100) / totalFiles;
            this.updateExtractionProgress(overallProgress);
          }
        );

        if (result.success) {
          completedFiles++;
          this.updateExtractionProgress(completedFiles / totalFiles, true);
        } else {
          await this.setExtractionFailedState(
            new Error(`7zip returned unsuccessful extraction for ${file}`),
            path.join(directoryPath, file)
          );
          return false;
        }
      } catch (err) {
        await this.setExtractionFailedState(
          err,
          path.join(directoryPath, file)
        );
        return false;
      }
    }

    const archivePaths = compressedFiles
      .map((file) => path.join(directoryPath, file))
      .filter((archivePath) => fs.existsSync(archivePath));

    if (archivePaths.length > 0) {
      const [download, userPreferences] = await Promise.all([
        downloadsSublevel.get(this.gameKey),
        db.get<string, UserPreferences | null>(levelKeys.userPreferences, {
          valueEncoding: "json",
        }),
      ]);

      const shouldDelete =
        download?.automaticallyDeleteArchiveFiles ??
        userPreferences?.deleteArchiveFilesAfterExtractionByDefault ??
        false;

      if (shouldDelete) {
        for (const archivePath of archivePaths) {
          await deleteArchiveFile(archivePath);
        }
      } else {
        WindowManager.sendToAppWindows(
          "on-archive-deletion-prompt",
          archivePaths
        );
      }
    }

    return true;
  }

  async setExtractionComplete(publishNotification = true) {
    const [download, game] = await Promise.all([
      downloadsSublevel.get(this.gameKey),
      gamesSublevel.get(this.gameKey),
    ]);

    if (!download) return;

    await downloadsSublevel.put(this.gameKey, {
      ...download,
      extracting: false,
    });
    WindowManager.sendDownloadsUpdated();

    // Calculate and store the installed size
    if (game && download.folderName) {
      const gamePath = path.join(download.downloadPath, download.folderName);
      const installedSizeInBytes = await getDirectorySize(gamePath);

      await gamesSublevel.put(this.gameKey, {
        ...game,
        installedSizeInBytes,
      });
    }

    WindowManager.sendToAppWindows(
      "on-extraction-complete",
      this.shop,
      this.objectId
    );

    if (publishNotification && game) {
      publishExtractionCompleteNotification(game);
    }

    this.lastProgressUpdateTime = 0;
    this.lastProgressUpdateValue = 0;

    if (download.autoInstallAfterExtraction && download.folderName) {
      const downloadTarget = path.join(
        download.downloadPath,
        download.folderName
      );

      // folderName may point at a loose data file inside the repack folder
      // (e.g. FitGirl repacks land as "<repack>/fg-01.bin" with no archive to
      // extract). In that case install from the containing folder so
      // findSetupExe can locate setup.exe.
      const installSource =
        fs.existsSync(downloadTarget) && fs.statSync(downloadTarget).isFile()
          ? path.dirname(downloadTarget)
          : downloadTarget;

      await this.runAutoInstall(installSource, download.installPath ?? null);
    } else {
      await this.searchAndBindExecutable();
    }

    await this.autoLinkClassicsDiscs();
  }

  private async findSetupExe(folderPath: string): Promise<string | null> {
    // Prefer setup.exe at the root level first
    const rootSetup = path.join(folderPath, "setup.exe");
    if (fs.existsSync(rootSetup)) return rootSetup;

    // Fall back to recursive search for setup.exe
    try {
      const entries = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
        recursive: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.toLowerCase() === "setup.exe") {
          const parentPath =
            "parentPath" in entry
              ? entry.parentPath
              : (entry as unknown as { path?: string }).path || folderPath;
          return path.join(parentPath, entry.name);
        }
      }
    } catch {
      // Ignore read errors
    }

    return null;
  }

  private sendInstallerProgress(
    progress: number,
    status: "running" | "complete" | "failed"
  ) {
    WindowManager.sendToAppWindows(
      "on-installer-progress",
      this.shop,
      this.objectId,
      progress,
      status
    );
  }

  async runAutoInstall(
    extractedPath: string,
    installPath: string | null
  ): Promise<void> {
    const setupExePath = await this.findSetupExe(extractedPath);

    if (!setupExePath) {
      logger.info(
        `[GameFilesManager] No setup.exe found in ${extractedPath}, falling back to exe search`
      );
      await this.searchAndBindExecutable();
      return;
    }

    const cleanTitle =
      removeSymbolsFromName(
        (await gamesSublevel.get(this.gameKey))?.title ?? this.objectId
      ).trim() || this.objectId;

    // Always install into a per-game subfolder named after the title - including
    // when the user picks a custom install path. Installing several games straight
    // into one shared folder is unsafe: the game's own InnoSetup uninstaller deletes
    // its whole install directory, so uninstalling one game would wipe that shared
    // folder and every other game in it.
    const installBase =
      installPath ??
      (process.platform === "win32"
        ? "C:\\Program Files"
        : path.join(process.env.HOME ?? "/home/user", "Games"));
    let effectiveInstallPath = path.join(installBase, cleanTitle);

    // Never install into the repack's own folder: it holds setup.exe and the
    // .bin data files, and InnoSetup refuses to install into its source dir
    // (exit code 1). Redirect to a clean sibling folder next to the repack.
    const isWithin = (target: string, root: string) => {
      const rel = path.relative(path.resolve(root), path.resolve(target));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (
      isWithin(effectiveInstallPath, extractedPath) ||
      isWithin(effectiveInstallPath, path.dirname(setupExePath))
    ) {
      const fallback = path.join(path.dirname(extractedPath), cleanTitle);
      logger.warn(
        `[GameFilesManager] Install path "${effectiveInstallPath}" is inside the repack source; redirecting to "${fallback}"`
      );
      effectiveInstallPath = fallback;
    }

    logger.info(
      `[GameFilesManager] Auto-installing via ${setupExePath} to ${effectiveInstallPath}`
    );

    this.sendInstallerProgress(0, "running");

    // Estimate installed size from the compressed download (repacks decompress
    // to roughly 1.5-2.5x). Measure growth from the directory's initial size so
    // a pre-populated target (e.g. an existing folder) doesn't peg the bar at
    // the cap immediately.
    const download = await downloadsSublevel.get(this.gameKey);
    const estimatedGrowthBytes = (download?.fileSize ?? 0) * 2;
    const initialBytes = fs.existsSync(effectiveInstallPath)
      ? await getDirectorySize(effectiveInstallPath)
      : 0;

    // Poll without overlap: each directory walk must finish before the next is
    // scheduled. A repack installer churns thousands of files, so a fixed
    // setInterval would stack concurrent recursive walks and saturate the main
    // process event loop (UI freeze) until it runs out of memory.
    let pollingActive = true;
    const pollProgress = async () => {
      while (pollingActive) {
        try {
          if (fs.existsSync(effectiveInstallPath)) {
            const currentBytes = await getDirectorySize(effectiveInstallPath);
            // The walk may outlast the installer; don't emit a stale "running"
            // update after the final "complete"/"failed" status was sent.
            if (!pollingActive) break;
            const grownBytes = Math.max(0, currentBytes - initialBytes);
            const progress =
              estimatedGrowthBytes > 0
                ? Math.min(grownBytes / estimatedGrowthBytes, 0.99)
                : 0;
            this.sendInstallerProgress(progress, "running");
          }
        } catch {
          // Ignore polling errors
        }

        if (!pollingActive) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };

    void pollProgress();

    try {
      const exitCode = await this.spawnInstaller(
        setupExePath,
        effectiveInstallPath
      );

      pollingActive = false;

      if (exitCode === 0) {
        logger.info(
          `[GameFilesManager] Auto-install completed successfully for ${this.objectId}`
        );
        this.sendInstallerProgress(1, "complete");
        await this.searchAndBindExecutableInPath(effectiveInstallPath);
        await this.recordInstallFolder(effectiveInstallPath);
        await this.deleteRepackFolder(
          extractedPath,
          download?.downloadPath ?? null
        );
      } else {
        logger.error(
          `[GameFilesManager] Auto-install exited with code ${exitCode} for ${this.objectId}`
        );
        this.sendInstallerProgress(0, "failed");
      }
    } catch (err) {
      pollingActive = false;
      logger.error(
        `[GameFilesManager] Auto-install failed for ${this.objectId}`,
        err
      );
      this.sendInstallerProgress(0, "failed");
    }
  }

  private spawnInstaller(
    setupExePath: string,
    installPath: string
  ): Promise<number> {
    // InnoSetup silent flags: completely silent, no message boxes, set dir, no
    // restart. /MERGETASKS=!desktopicon deselects the installer's "create a
    // desktop shortcut" task so the repack doesn't litter the desktop.
    const innoArgs = (dir: string) => [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      `/DIR=${dir}`,
      "/NORESTART",
      "/SP-",
      "/MERGETASKS=!desktopicon",
    ];

    if (process.platform === "win32") {
      const args = innoArgs(installPath);
      // Run from the setup.exe folder: FitGirl/InnoSetup installers resolve
      // their fg-*.bin data files relative to the working directory, so a wrong
      // cwd makes the install abort (exit 1) without writing anything.
      const setupDir = path.dirname(setupExePath);

      return new Promise<number>((resolve, reject) => {
        const child = spawn(setupExePath, args, {
          cwd: setupDir,
          detached: false,
          stdio: "ignore",
        });
        child.once("close", (code) => resolve(code ?? 1));
        child.once("error", reject);
      }).catch((error: NodeJS.ErrnoException) => {
        // FitGirl/InnoSetup installers usually require elevation; spawning the
        // exe directly fails with EACCES. Relaunch through ShellExecute "runas"
        // (Start-Process -Verb RunAs) so Windows shows a UAC prompt.
        if (error.code === "EACCES") {
          return this.spawnElevatedInstallerWindows(
            setupExePath,
            args,
            installPath
          );
        }
        throw error;
      });
    }

    // Auto-install is currently only supported on Windows (the modal toggle is
    // gated to win32). The repack installers are Windows InnoSetup executables.
    return Promise.reject(
      new Error("Auto-install is only supported on Windows")
    );
  }

  private spawnElevatedInstallerWindows(
    setupExePath: string,
    args: string[],
    installPath: string
  ): Promise<number> {
    // Run ELEVATED_INSTALLER_SCRIPT (see its header): one UAC prompt, then a
    // clean game-only silent install (skip DirectX/redist, mute the installer
    // music, skip file verification and the hosts-redirection step). A declined
    // UAC resolves to exit 1223 (ERROR_CANCELLED) so auto-install fails cleanly.
    const script = ELEVATED_INSTALLER_SCRIPT;
    const scriptPath = path.join(
      app.getPath("temp"),
      "hydra-elevated-install.ps1"
    );

    // Pass the installer args as one base64 string, not a PowerShell array:
    // `powershell -File` binds only the first value to a [string[]] param and
    // errors on the rest. The string is decoded straight into
    // ProcessStartInfo.Arguments, so quote args that contain spaces.
    const argsString = args
      .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
      .join(" ");
    const argsB64 = Buffer.from(argsString, "utf16le").toString("base64");

    return new Promise<number>((resolve, reject) => {
      try {
        fs.writeFileSync(scriptPath, script, "utf8");
      } catch (error) {
        reject(error as Error);
        return;
      }

      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Exe",
          setupExePath,
          "-ProcessName",
          "setup",
          "-InstallDir",
          installPath,
          "-ArgsB64",
          argsB64,
        ],
        { detached: false, stdio: "ignore" }
      );
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", reject);
    });
  }

  private async recordInstallFolder(installFolder: string) {
    try {
      const game = await gamesSublevel.get(this.gameKey);
      if (game) {
        await gamesSublevel.put(this.gameKey, { ...game, installFolder });
      }
    } catch {
      // Non-fatal: the uninstaller can still be located from executablePath.
    }
  }

  // True when deleting `target` would also remove the download-location root
  // (the user's "download path") or one of its ancestors / a drive root. We must
  // never recursively delete those: the download folder holds the user's other
  // downloads, and the parent should always survive a cleanup/uninstall.
  private isProtectedDeletionTarget(
    target: string,
    downloadRoot: string | null
  ): boolean {
    const resolvedTarget = path.resolve(target);

    // A filesystem/drive root (its own parent).
    if (path.dirname(resolvedTarget) === resolvedTarget) return true;

    if (downloadRoot) {
      const root = path.resolve(downloadRoot);
      if (resolvedTarget === root) return true;

      // If the download root is inside the target, the target is an ancestor of
      // it - deleting the target would take the download location with it.
      const rootRelativeToTarget = path.relative(resolvedTarget, root);
      if (
        rootRelativeToTarget !== "" &&
        !rootRelativeToTarget.startsWith("..") &&
        !path.isAbsolute(rootRelativeToTarget)
      ) {
        return true;
      }
    }

    return false;
  }

  private async deleteRepackFolder(
    repackFolder: string,
    downloadRoot: string | null
  ) {
    try {
      if (!fs.existsSync(repackFolder)) return;
      if (this.isProtectedDeletionTarget(repackFolder, downloadRoot)) {
        logger.warn(
          `[GameFilesManager] Skipping repack cleanup of ${repackFolder}: it is the download-location root (keeping it)`
        );
        return;
      }
      await fs.promises.rm(repackFolder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      logger.info(
        `[GameFilesManager] Deleted repack source folder ${repackFolder}`
      );
    } catch (err) {
      logger.error(
        `[GameFilesManager] Failed to delete repack folder ${repackFolder}`,
        err
      );
    }
  }

  private async findUninstaller(installFolder: string): Promise<string | null> {
    try {
      if (!fs.existsSync(installFolder)) return null;
      const entries = await fs.promises.readdir(installFolder);
      // InnoSetup names its uninstaller unins000.exe (unins001.exe, ...).
      const uninstaller = entries.find((name) =>
        /^unins\d{3}\.exe$/i.test(name)
      );
      return uninstaller ? path.join(installFolder, uninstaller) : null;
    } catch {
      return null;
    }
  }

  private async removeGameShortcuts(gameTitle: string) {
    if (process.platform !== "win32") return;

    const shortcutName =
      removeSymbolsFromName(gameTitle).trim() || this.objectId;

    const shortcutDirs = [
      SystemPath.getPath("desktop"),
      path.join(
        SystemPath.getPath("appData"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs"
      ),
    ];

    for (const dir of shortcutDirs) {
      this.deleteShortcutIfExists(path.join(dir, `${shortcutName}.lnk`));
      this.deleteShortcutIfExists(path.join(dir, `${shortcutName}.url`));
    }
  }

  private runUninstaller(
    uninstallerPath: string,
    workDir: string
  ): Promise<number> {
    const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];

    return new Promise<number>((resolve, reject) => {
      const child = spawn(uninstallerPath, args, {
        cwd: workDir,
        detached: false,
        stdio: "ignore",
      });
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", reject);
    }).catch((error: NodeJS.ErrnoException) => {
      // Uninstallers for per-machine installs need elevation (EACCES); relaunch
      // through ShellExecute "runas" for a UAC prompt.
      if (error.code === "EACCES") {
        return this.spawnElevatedRunWindows(uninstallerPath, args, workDir);
      }
      throw error;
    });
  }

  private spawnElevatedRunWindows(
    exePath: string,
    args: string[],
    workDir: string
  ): Promise<number> {
    const script = ELEVATED_RUN_SCRIPT;
    const scriptPath = path.join(app.getPath("temp"), "hydra-elevated-run.ps1");
    const argsString = args
      .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
      .join(" ");
    const argsB64 = Buffer.from(argsString, "utf16le").toString("base64");

    return new Promise<number>((resolve, reject) => {
      try {
        fs.writeFileSync(scriptPath, script, "utf8");
      } catch (error) {
        reject(error as Error);
        return;
      }

      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Exe",
          exePath,
          "-WorkDir",
          workDir,
          "-ArgsB64",
          argsB64,
        ],
        { detached: false, stdio: "ignore" }
      );
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", reject);
    });
  }

  /**
   * Runs the game's official InnoSetup uninstaller and removes the shortcuts
   * Hydra created. Returns ok=false (without touching anything) when no
   * uninstaller is found or the UAC prompt is declined.
   */
  async uninstall(): Promise<{ ok: boolean; error?: string }> {
    const game = await gamesSublevel.get(this.gameKey);
    if (!game) return { ok: false, error: "game_not_found" };

    // Prefer the recorded install folder; otherwise walk up from the bound
    // executable (the uninstaller sits at the install root, the exe may nest).
    const candidateFolders: string[] = [];
    if (game.installFolder) candidateFolders.push(game.installFolder);
    if (game.executablePath) {
      let dir = path.dirname(game.executablePath);
      for (let i = 0; i < 3; i++) {
        candidateFolders.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    let uninstallerPath: string | null = null;
    let installFolder = "";
    for (const folder of candidateFolders) {
      const found = await this.findUninstaller(folder);
      if (found) {
        uninstallerPath = found;
        installFolder = folder;
        break;
      }
    }

    if (!uninstallerPath) return { ok: false, error: "uninstaller_not_found" };

    // Safety: never let the uninstaller run against the download-location root (or an
    // ancestor / drive root). The official uninstaller deletes its whole install
    // directory, so this would wipe the user's download folder and everything in it.
    const download = await downloadsSublevel.get(this.gameKey);
    if (
      this.isProtectedDeletionTarget(
        installFolder,
        download?.downloadPath ?? null
      )
    ) {
      logger.warn(
        `[GameFilesManager] Refusing to uninstall ${this.objectId}: ${installFolder} is the download-location root`
      );
      return { ok: false, error: "uninstaller_shared_folder" };
    }

    // Safety: refuse if the install folder holds more than one InnoSetup uninstaller
    // (unins000.exe, unins001.exe, ...). That means several games were installed into
    // the same folder; the official uninstaller deletes its whole install directory,
    // so running it would wipe the sibling games too. New installs use a per-game
    // subfolder to avoid this - this guards games installed before that fix.
    try {
      const entries = await fs.promises.readdir(installFolder);
      const uninstallerCount = entries.filter((name) =>
        /^unins\d{3}\.exe$/i.test(name)
      ).length;
      if (uninstallerCount > 1) {
        logger.warn(
          `[GameFilesManager] Refusing to uninstall ${this.objectId}: ${installFolder} is shared by multiple games`
        );
        return { ok: false, error: "uninstaller_shared_folder" };
      }
    } catch {
      // If the folder can't be read, fall through and let the uninstaller decide.
    }

    logger.info(
      `[GameFilesManager] Uninstalling ${this.objectId} via ${uninstallerPath}`
    );

    let exitCode: number;
    try {
      exitCode = await this.runUninstaller(uninstallerPath, installFolder);
    } catch (err) {
      logger.error(
        `[GameFilesManager] Uninstaller failed for ${this.objectId}`,
        err
      );
      return { ok: false, error: "uninstaller_failed" };
    }

    // 1223 = ERROR_CANCELLED (declined UAC) -> leave everything untouched.
    if (exitCode === 1223) return { ok: false, error: "cancelled" };

    await this.removeGameShortcuts(game.title);
    return { ok: true };
  }

  private async searchAndBindExecutableInPath(
    installPath: string
  ): Promise<void> {
    try {
      const game = await gamesSublevel.get(this.gameKey);

      if (!game || game.executablePath) return;

      if (!fs.existsSync(installPath)) return;

      const executableNames = GameExecutables.getExecutablesForGame(
        this.objectId
      );

      let foundExePath: string | null = null;

      if (executableNames && executableNames.length > 0) {
        foundExePath = await this.findExecutableInFolder(
          installPath,
          executableNames
        );
      }

      // Fallback: find largest non-system exe in install path
      if (!foundExePath) {
        foundExePath = await this.findLargestGameExe(installPath);
      }

      if (foundExePath) {
        logger.info(
          `[GameFilesManager] Auto-detected game exe after install for ${this.objectId}: ${foundExePath}`
        );

        await gamesSublevel.put(this.gameKey, {
          ...updateGameExecutablePath(game, foundExePath),
        });

        WindowManager.sendToAppWindows("on-library-batch-complete");
        // Auto-install is meant to be clean: the game is launchable from the
        // Hydra library, so skip the desktop shortcut (Start Menu is still
        // created, gated by the user's preference).
        await this.createDesktopShortcutForGame(game.title, { desktop: false });
      } else {
        logger.info(
          `[GameFilesManager] No game exe found in install path ${installPath} for ${this.objectId}`
        );
        // Fall back to searching the extraction folder
        await this.searchAndBindExecutable();
      }
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error searching for executable after install: ${this.objectId}`,
        err
      );
    }
  }

  private readonly SYSTEM_EXE_PATTERNS = [
    /^unins/i,
    /^setup/i,
    /^install/i,
    /^vcredist/i,
    /^vc_redist/i,
    /^dxsetup/i,
    /^directx/i,
    /^unarc/i,
    /^dotnet/i,
    /^crashreport/i,
    /^crash_report/i,
    /^report/i,
    /^launcher_setup/i,
  ];

  private async findLargestGameExe(folderPath: string): Promise<string | null> {
    try {
      const entries = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
        recursive: true,
      });

      let bestExe: { path: string; size: number } | null = null;

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (path.extname(entry.name).toLowerCase() !== ".exe") continue;

        const isSystemExe = this.SYSTEM_EXE_PATTERNS.some((pattern) =>
          pattern.test(entry.name)
        );
        if (isSystemExe) continue;

        const parentPath =
          "parentPath" in entry
            ? entry.parentPath
            : (entry as unknown as { path?: string }).path || folderPath;

        const fullPath = path.join(parentPath, entry.name);

        try {
          const stat = fs.statSync(fullPath);
          if (!bestExe || stat.size > bestExe.size) {
            bestExe = { path: fullPath, size: stat.size };
          }
        } catch {
          // Ignore stat errors
        }
      }

      return bestExe ? bestExe.path : null;
    } catch {
      return null;
    }
  }

  async autoLinkClassicsDiscs(): Promise<void> {
    try {
      const [download, game] = await Promise.all([
        downloadsSublevel.get(this.gameKey),
        gamesSublevel.get(this.gameKey),
      ]);

      if (!download || game?.shop !== "launchbox") return;
      if (!download.folderName) return;

      const system = platformToSystem(game.platform);
      if (!system) return;

      const gameFolderPath = path.join(
        download.downloadPath,
        download.folderName
      );

      if (!fs.existsSync(gameFolderPath)) return;

      const { games: scanned } = await emulators.scanRomFolder(
        gameFolderPath,
        emulators.KNOWN_BINARIES[system],
        true
      );

      if (scanned.length === 0) return;

      const discs = [...(game.discs ?? [])];
      let added = 0;

      for (const entry of scanned) {
        if (discs.some((disc) => disc.path === entry.primaryPath)) continue;

        const sku = await emulators.extractDiscSku(entry.primaryPath, system);

        discs.push({
          path: entry.primaryPath,
          label: `Disc ${discs.length + 1}`,
          fileName: path.basename(entry.primaryPath),
          sku,
        });
        added += 1;
      }

      if (added === 0) return;

      await gamesSublevel.put(this.gameKey, {
        ...game,
        discs,
        selectedDiscPath: game.selectedDiscPath ?? discs[0]?.path ?? null,
      });

      WindowManager.sendToAppWindows("on-library-batch-complete");

      logger.info(
        `[GameFilesManager] Auto-linked ${added} disc(s) for ${this.objectId}`
      );
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error auto-linking classics discs: ${this.objectId}`,
        err
      );
    }
  }

  async searchAndBindExecutable(): Promise<void> {
    try {
      const [download, game] = await Promise.all([
        downloadsSublevel.get(this.gameKey),
        gamesSublevel.get(this.gameKey),
      ]);

      if (!download || !game || game.executablePath) {
        return;
      }

      const executableNames = GameExecutables.getExecutablesForGame(
        this.objectId
      );

      if (!executableNames || executableNames.length === 0) {
        return;
      }

      if (!download.folderName) {
        return;
      }

      const gameFolderPath = path.join(
        download.downloadPath,
        download.folderName
      );

      if (!fs.existsSync(gameFolderPath)) {
        return;
      }

      const foundExePath = await this.findExecutableInFolder(
        gameFolderPath,
        executableNames
      );

      if (foundExePath) {
        logger.info(
          `[GameFilesManager] Auto-detected executable for ${this.objectId}: ${foundExePath}`
        );

        await gamesSublevel.put(this.gameKey, {
          ...updateGameExecutablePath(game, foundExePath),
        });

        WindowManager.sendToAppWindows("on-library-batch-complete");

        await this.createDesktopShortcutForGame(game.title);
      }
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error searching for executable: ${this.objectId}`,
        err
      );
    }
  }

  private isValidHttpUrl(url: string | null | undefined): url is string {
    return !!url && (url.startsWith("http://") || url.startsWith("https://"));
  }

  private isIcoUrl(url: string): boolean {
    return url.toLowerCase().endsWith(".ico");
  }

  private async downloadGameIcon(): Promise<string | null> {
    if (this.shop === "custom") {
      return null;
    }

    const iconDir = path.join(ASSETS_PATH, `${this.shop}-${this.objectId}`);
    const iconPath = path.join(iconDir, "icon.ico");

    try {
      if (fs.existsSync(iconPath)) {
        return iconPath;
      }
    } catch {
      // Ignore fs errors
    }

    const game = await gamesSublevel.get(this.gameKey);
    const assets = await getGameAssets(this.objectId, this.shop);

    const iconUrls = [
      assets?.iconUrl,
      game?.iconUrl,
      assets?.coverImageUrl,
    ].filter(this.isValidHttpUrl);

    if (iconUrls.length === 0) {
      logger.warn(
        `[GameFilesManager] No valid icon URLs found for: ${this.objectId}`
      );
      return null;
    }

    fs.mkdirSync(iconDir, { recursive: true });

    for (const iconUrl of iconUrls) {
      try {
        logger.log(
          `[GameFilesManager] Trying to download icon from: ${iconUrl}`
        );
        const response = await axios.get(iconUrl, {
          responseType: "arraybuffer",
        });
        const imageBuffer = Buffer.from(response.data);

        // If source is already ICO, use it directly
        if (this.isIcoUrl(iconUrl)) {
          fs.writeFileSync(iconPath, imageBuffer);
          logger.log(`[GameFilesManager] Copied ICO directly to: ${iconPath}`);
          return iconPath;
        }

        // Convert to square PNG (256x256 is standard for ICO), then to ICO
        const pngBuffer = await sharp(imageBuffer)
          .resize(256, 256, { fit: "cover" })
          .png()
          .toBuffer();
        const icoBuffer = await pngToIco(pngBuffer);
        fs.writeFileSync(iconPath, icoBuffer);

        logger.log(
          `[GameFilesManager] Successfully created icon at: ${iconPath}`
        );
        return iconPath;
      } catch (error) {
        logger.warn(
          `[GameFilesManager] Failed to convert icon from ${iconUrl}:`,
          error
        );
      }
    }

    logger.error(
      `[GameFilesManager] Failed to download/convert icon from any source: ${this.objectId}`
    );
    return null;
  }

  private createUrlShortcut(
    shortcutPath: string,
    url: string,
    iconPath?: string | null
  ): boolean {
    try {
      fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });

      if (fs.existsSync(shortcutPath)) {
        fs.unlinkSync(shortcutPath);
      }

      let content = `[InternetShortcut]\nURL=${url}\n`;

      if (iconPath) {
        content += `IconFile=${iconPath}\nIconIndex=0\n`;
      }

      fs.writeFileSync(shortcutPath, content);
      return true;
    } catch (error) {
      logger.error(
        `[GameFilesManager] Failed to create URL shortcut: ${this.objectId}`,
        error
      );
      return false;
    }
  }

  private deleteShortcutIfExists(shortcutPath: string) {
    try {
      if (fs.existsSync(shortcutPath)) {
        fs.unlinkSync(shortcutPath);
      }
    } catch (error) {
      logger.warn(
        `[GameFilesManager] Failed to delete existing shortcut: ${shortcutPath}`,
        error
      );
    }
  }

  private buildRunDeepLink() {
    const query = new URLSearchParams({
      shop: this.shop,
      objectId: this.objectId,
    });

    return `hydralauncher://run?${query.toString()}`;
  }

  private quoteLinuxExecArg(value: string) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  private getShortcutArguments(deepLink: string) {
    const deepLinkArgument =
      process.platform === "linux"
        ? this.quoteLinuxExecArg(deepLink)
        : deepLink;

    if (process.defaultApp && process.argv.length >= 2) {
      const appEntry = path.resolve(process.argv[1]);
      const appEntryArgument =
        process.platform === "linux"
          ? this.quoteLinuxExecArg(appEntry)
          : appEntry;

      return `${appEntryArgument} ${deepLinkArgument}`;
    }

    return deepLinkArgument;
  }

  private createWindowsShortcut(
    shortcutName: string,
    outputPath: string,
    deepLink: string,
    iconPath?: string | null
  ): boolean {
    fs.mkdirSync(outputPath, { recursive: true });

    const linkPath = path.join(outputPath, `${shortcutName}.lnk`);
    const urlPath = path.join(outputPath, `${shortcutName}.url`);

    this.deleteShortcutIfExists(linkPath);
    this.deleteShortcutIfExists(urlPath);

    const windowVbsPath = app.isPackaged
      ? path.join(process.resourcesPath, "windows.vbs")
      : undefined;

    const nativeShortcutCreated = createDesktopShortcut({
      windows: {
        filePath: process.execPath,
        arguments: deepLink,
        name: shortcutName,
        outputPath,
        icon: iconPath ?? process.execPath,
        VBScriptPath: windowVbsPath,
      },
    });

    if (nativeShortcutCreated) {
      return true;
    }

    return this.createUrlShortcut(
      urlPath,
      deepLink,
      iconPath ?? process.execPath
    );
  }

  private async createDesktopShortcutForGame(
    gameTitle: string,
    shortcutOptions?: { desktop?: boolean }
  ): Promise<void> {
    try {
      const createDesktop = shortcutOptions?.desktop !== false;
      const shortcutName =
        removeSymbolsFromName(gameTitle).trim() || this.objectId;
      const deepLink = this.buildRunDeepLink();
      const shortcutArguments = this.getShortcutArguments(deepLink);
      const iconPath = await this.downloadGameIcon();

      if (process.platform === "win32") {
        const userPreferences = await db.get<string, UserPreferences | null>(
          levelKeys.userPreferences,
          { valueEncoding: "json" }
        );

        const shouldCreateDownloadShortcuts =
          userPreferences?.createStartMenuShortcut ?? true;

        if (!shouldCreateDownloadShortcuts) {
          return;
        }

        if (createDesktop) {
          const desktopSuccess = this.createWindowsShortcut(
            shortcutName,
            SystemPath.getPath("desktop"),
            deepLink,
            iconPath
          );

          if (desktopSuccess) {
            logger.info(
              `[GameFilesManager] Created desktop shortcut for ${this.objectId}`
            );
          }
        }

        const startMenuPath = path.join(
          SystemPath.getPath("appData"),
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs"
        );

        const startMenuSuccess = this.createWindowsShortcut(
          shortcutName,
          startMenuPath,
          deepLink,
          iconPath
        );

        if (startMenuSuccess) {
          logger.info(
            `[GameFilesManager] Created Start Menu shortcut for ${this.objectId}`
          );
        }
      } else {
        const windowVbsPath = app.isPackaged
          ? path.join(process.resourcesPath, "windows.vbs")
          : undefined;

        const options = {
          filePath: process.execPath,
          arguments: shortcutArguments,
          name: shortcutName,
          outputPath: SystemPath.getPath("desktop"),
          icon: iconPath ?? undefined,
        };

        const desktopSuccess = createDesktopShortcut({
          windows: { ...options, VBScriptPath: windowVbsPath },
          linux: options,
          osx: options,
        });

        if (desktopSuccess) {
          logger.info(
            `[GameFilesManager] Created desktop shortcut for ${this.objectId}`
          );
        }
      }
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error creating desktop shortcut: ${this.objectId}`,
        err
      );
    }
  }

  private async findExecutableInFolder(
    folderPath: string,
    executableNames: string[]
  ): Promise<string | null> {
    const normalizedNames = new Set(
      executableNames.map((name) => name.toLowerCase())
    );

    try {
      const entries = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
        recursive: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const fileName = entry.name.toLowerCase();

        if (normalizedNames.has(fileName)) {
          const parentPath =
            "parentPath" in entry
              ? entry.parentPath
              : (entry as unknown as { path?: string }).path || folderPath;

          return path.join(parentPath, entry.name);
        }
      }
    } catch {
      // Silently fail if folder cannot be read
    }

    return null;
  }

  async extractDownloadedFile() {
    const [download, game] = await Promise.all([
      downloadsSublevel.get(this.gameKey),
      gamesSublevel.get(this.gameKey),
    ]);

    if (!download || !game) return false;

    if (!download.folderName) {
      await this.setExtractionFailedState(
        new Error("No downloaded archive was found to extract")
      );
      return false;
    }

    const filePath = path.join(download.downloadPath, download.folderName);

    const extractionPath = path.join(
      download.downloadPath,
      path.parse(download.folderName!).name
    );

    this.updateExtractionProgress(0, true);

    try {
      const result = await SevenZip.extractFile(
        {
          filePath,
          outputPath: extractionPath,
          passwords: ["online-fix.me", "steamrip.com"],
        },
        this.handleProgress
      );

      if (result.success) {
        const extractedNestedArchives =
          await this.extractFilesInDirectory(extractionPath);

        if (!extractedNestedArchives) {
          return false;
        }

        if (fs.existsSync(extractionPath) && fs.existsSync(filePath)) {
          const userPreferences = await db.get<string, UserPreferences | null>(
            levelKeys.userPreferences,
            { valueEncoding: "json" }
          );

          const shouldDelete =
            download.automaticallyDeleteArchiveFiles ??
            userPreferences?.deleteArchiveFilesAfterExtractionByDefault ??
            false;

          if (shouldDelete) {
            await deleteArchiveFile(filePath);
          } else {
            WindowManager.sendToAppWindows("on-archive-deletion-prompt", [
              filePath,
            ]);
          }
        }

        await downloadsSublevel.put(this.gameKey, {
          ...download,
          folderName: path.parse(download.folderName!).name,
        });

        await this.setExtractionComplete();
      } else {
        await this.setExtractionFailedState(
          new Error("7zip returned unsuccessful extraction"),
          filePath
        );
        return false;
      }
    } catch (err) {
      await this.setExtractionFailedState(err, filePath);
      return false;
    }

    return true;
  }
}
