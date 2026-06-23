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
import { Umu } from "./umu";

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
            if (string.Equals(p.ProcessName, name, StringComparison.OrdinalIgnoreCase)) {
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

function Start-Setup([string]$arguments) {
  $p = New-Object System.Diagnostics.ProcessStartInfo
  $p.FileName = $Exe
  $p.WorkingDirectory = $workDir
  $p.UseShellExecute = $false
  $p.Arguments = $arguments
  return [System.Diagnostics.Process]::Start($p)
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
  for ($i = 0; $i -lt 60; $i++) {
    if ($muteReady) { try { [HydraAudio.Mixer]::MuteByProcessName($ProcessName) } catch { } }
    if (Test-Path -LiteralPath $infFile) { break }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep -Milliseconds 300
  try { if ($probe -and -not $probe.HasExited) { $probe.Kill() } } catch { }
  Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
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

# Pass 2: real install (game-only components) while muting setup's audio and
# killing the file verifier (QuickSFV) as soon as it spawns.
$installArgs = $baseArgs
if ($components) { $installArgs = $installArgs + ' "/COMPONENTS=' + $components + '"' }

$proc = $null
try { $proc = Start-Setup $installArgs } catch { exit 1 }

Start-Sleep -Milliseconds 1200
while ($true) {
  if ($muteReady) { try { [HydraAudio.Mixer]::MuteByProcessName($ProcessName) } catch { } }
  Get-Process -Name 'QuickSFV' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $alive = $false
  if ($proc) { try { if (-not $proc.HasExited) { $alive = $true } } catch { $alive = $false } }
  if (-not $alive -and (Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)) { $alive = $true }
  if (-not $alive) { break }
  Start-Sleep -Milliseconds 500
}

$code = 1
try { if ($proc -and $proc.HasExited) { $code = $proc.ExitCode } } catch { $code = 0 }

# A relaunched installer can exit non-zero while the real install (in a child)
# succeeds, so treat a populated target dir as success.
if ($code -ne 0 -and $InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
  try {
    $sz = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($sz -gt 52428800) { $code = 0 }
  } catch { }
}
exit $code
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

    let effectiveInstallPath =
      installPath ??
      path.join(
        process.platform === "win32"
          ? "C:\\Program Files"
          : path.join(process.env.HOME ?? "/home/user", "Games"),
        cleanTitle
      );

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

    try {
      await downloadsSublevel.put(this.gameKey, {
        ...(await downloadsSublevel.get(this.gameKey))!,
        installing: true,
        installerProgress: 0,
      });
      WindowManager.sendDownloadsUpdated();
    } catch {
      // Non-fatal
    }

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

            const currentDownload = await downloadsSublevel.get(this.gameKey);
            if (currentDownload) {
              await downloadsSublevel.put(this.gameKey, {
                ...currentDownload,
                installerProgress: progress,
              });
            }
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

        try {
          const currentDownload = await downloadsSublevel.get(this.gameKey);
          if (currentDownload) {
            await downloadsSublevel.put(this.gameKey, {
              ...currentDownload,
              installing: false,
              installerProgress: 1,
              installPath: effectiveInstallPath,
            });
          }
        } catch {
          // Non-fatal
        }

        WindowManager.sendDownloadsUpdated();
        await this.searchAndBindExecutableInPath(effectiveInstallPath);
      } else {
        logger.error(
          `[GameFilesManager] Auto-install exited with code ${exitCode} for ${this.objectId}`
        );
        this.sendInstallerProgress(0, "failed");
        await this.clearInstallingState();
      }
    } catch (err) {
      pollingActive = false;
      logger.error(
        `[GameFilesManager] Auto-install failed for ${this.objectId}`,
        err
      );
      this.sendInstallerProgress(0, "failed");
      await this.clearInstallingState();
    }
  }

  private async clearInstallingState() {
    try {
      const currentDownload = await downloadsSublevel.get(this.gameKey);
      if (currentDownload) {
        await downloadsSublevel.put(this.gameKey, {
          ...currentDownload,
          installing: false,
          installerProgress: 0,
        });
        WindowManager.sendDownloadsUpdated();
      }
    } catch {
      // Non-fatal
    }
  }

  private spawnInstaller(
    setupExePath: string,
    installPath: string
  ): Promise<number> {
    // InnoSetup silent flags: completely silent, no message boxes, set dir, no restart
    const innoArgs = (dir: string) => [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      `/DIR=${dir}`,
      "/NORESTART",
      "/SP-",
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

    if (process.platform === "linux") {
      // Wine maps Z: to the root of the filesystem
      const wineInstallPath = `Z:${installPath.replace(/\//g, "\\")}`;
      return Umu.launchExecutable(setupExePath, innoArgs(wineInstallPath), {})
        .then(() => 0)
        .catch(() => {
          // Fallback to bare wine if umu-run is unavailable
          return new Promise<number>((resolve, reject) => {
            const child = spawn(
              "wine",
              [setupExePath, ...innoArgs(wineInstallPath)],
              { detached: false, stdio: "ignore" }
            );
            child.once("close", (code) => resolve(code ?? 1));
            child.once("error", reject);
          });
        });
    }

    return Promise.reject(new Error("Auto-install not supported on macOS"));
  }

  private spawnElevatedInstallerWindows(
    setupExePath: string,
    args: string[],
    installPath: string
  ): Promise<number> {
    // Launch the installer elevated (UAC) and keep its audio muted as a
    // best-effort: FitGirl/InnoSetup installers play music that no command-line
    // flag can disable, so we mute the "setup" process audio session via the
    // Windows Core Audio API on a short loop until the installer exits. A
    // declined UAC prompt is reported as a non-zero exit (1223 = ERROR_CANCELLED)
    // so the auto-install fails gracefully. Muting failures never abort the run.
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
        await this.createDesktopShortcutForGame(game.title);
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

  private async createDesktopShortcutForGame(gameTitle: string): Promise<void> {
    try {
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
