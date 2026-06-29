import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import fs from "node:fs";
import path from "node:path";
import { DownloadManager, GameFilesManager, logger } from "@main/services";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { Downloader, FILE_EXTENSIONS_TO_EXTRACT } from "@shared";

const extractGameDownload = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<boolean> => {
  const gameKey = levelKeys.game(shop, objectId);

  const [download, game] = await Promise.all([
    downloadsSublevel.get(gameKey),
    gamesSublevel.get(gameKey),
  ]);

  if (!download || !game) {
    const gameFilesManager = new GameFilesManager(shop, objectId);
    await gameFilesManager.failExtraction(
      new Error(
        "Could not start extraction because download metadata is missing"
      )
    );
    return false;
  }

  await downloadsSublevel.put(gameKey, {
    ...download,
    extracting: true,
  });

  const gameFilesManager = new GameFilesManager(shop, objectId);
  const targetFolderName = download.folderName;

  if (!targetFolderName) {
    await gameFilesManager.failExtraction(
      new Error("No downloaded archive was found to extract")
    );
    return false;
  }

  const runExtraction = () => {
    if (
      FILE_EXTENSIONS_TO_EXTRACT.some((ext) =>
        targetFolderName.toLowerCase().endsWith(ext)
      )
    ) {
      return gameFilesManager.extractDownloadedFile().catch((error) => {
        return gameFilesManager.failExtraction(error).catch(() => {
          // Fail state persistence is already logged in GameFilesManager
        });
      });
    }

    // folderName may point at a loose data file inside the repack folder
    // (e.g. FitGirl: "<repack>/fg-01.bin"); extract from the containing folder.
    const downloadTarget = path.join(download.downloadPath, targetFolderName);
    const extractionDir =
      fs.existsSync(downloadTarget) && fs.statSync(downloadTarget).isFile()
        ? path.dirname(downloadTarget)
        : downloadTarget;

    return gameFilesManager
      .extractFilesInDirectory(extractionDir)
      .then((success) => {
        if (success) {
          return gameFilesManager.setExtractionComplete(false).catch(() => {
            // Extraction completion failures are already logged downstream
          });
        }

        return undefined;
      })
      .catch((error) => {
        return gameFilesManager.failExtraction(error).catch(() => {
          // Fail state persistence is already logged in GameFilesManager
        });
      });
  };

  const shouldPauseSeedingForExtraction =
    download.downloader === Downloader.Torrent &&
    download.shouldSeed &&
    download.status === "seeding";

  if (shouldPauseSeedingForExtraction) {
    await DownloadManager.pauseSeeding(gameKey).catch((error) => {
      logger.error(
        "[extractGameDownload] Failed to pause seeding before extraction",
        error
      );
    });

    void runExtraction().finally(() => {
      DownloadManager.resumeSeeding(download).catch((error) => {
        logger.error(
          "[extractGameDownload] Failed to resume seeding after extraction",
          error
        );
      });
    });
  } else {
    void runExtraction();
  }

  return true;
};

registerEvent("extractGameDownload", extractGameDownload);
