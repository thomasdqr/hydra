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
      const extractedPath = path.join(
        download.downloadPath,
        download.folderName
      );
      await this.runAutoInstall(extractedPath, download.installPath ?? null);
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

  private sendInstallerProgress(progress: number, status: "running" | "complete" | "failed") {
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

    const effectiveInstallPath =
      installPath ??
      path.join(
        process.platform === "win32"
          ? "C:\\Program Files"
          : path.join(process.env.HOME ?? "/home/user", "Games"),
        removeSymbolsFromName(
          (await gamesSublevel.get(this.gameKey))?.title ?? this.objectId
        ).trim() || this.objectId
      );

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

    // Estimate target size: compressed file size * 4 (rough ratio for repacks)
    const download = await downloadsSublevel.get(this.gameKey);
    const estimatedFinalBytes = (download?.fileSize ?? 0) * 4;

    const pollInterval = setInterval(async () => {
      try {
        if (!fs.existsSync(effectiveInstallPath)) return;
        const currentBytes = await getDirectorySize(effectiveInstallPath);
        const progress =
          estimatedFinalBytes > 0
            ? Math.min(currentBytes / estimatedFinalBytes, 0.95)
            : 0;
        this.sendInstallerProgress(progress, "running");

        const currentDownload = await downloadsSublevel.get(this.gameKey);
        if (currentDownload) {
          await downloadsSublevel.put(this.gameKey, {
            ...currentDownload,
            installerProgress: progress,
          });
        }
      } catch {
        // Ignore polling errors
      }
    }, 1500);

    try {
      const exitCode = await this.spawnInstaller(setupExePath, effectiveInstallPath);

      clearInterval(pollInterval);

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
      clearInterval(pollInterval);
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
      return new Promise((resolve, reject) => {
        const child = spawn(setupExePath, innoArgs(installPath), {
          detached: false,
          stdio: "ignore",
        });
        child.once("close", (code) => resolve(code ?? 1));
        child.once("error", reject);
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

  private async searchAndBindExecutableInPath(installPath: string): Promise<void> {
    try {
      const game = await gamesSublevel.get(this.gameKey);

      if (!game || game.executablePath) return;

      if (!fs.existsSync(installPath)) return;

      const executableNames = GameExecutables.getExecutablesForGame(this.objectId);

      let foundExePath: string | null = null;

      if (executableNames && executableNames.length > 0) {
        foundExePath = await this.findExecutableInFolder(installPath, executableNames);
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
