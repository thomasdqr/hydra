import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import { GameFilesManager, logger } from "@main/services";
import { gamesSublevel, levelKeys } from "@main/level";

const uninstallGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<{ ok: boolean; error?: string }> => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return { ok: false, error: "game_not_found" };

  const gameFilesManager = new GameFilesManager(shop, objectId);
  const result = await gameFilesManager.uninstall();

  if (!result.ok) return result;

  // The official uninstaller removed the game files and Hydra removed its
  // shortcuts; mark the game as not installed (kept in the library).
  await gamesSublevel.put(gameKey, {
    ...game,
    executablePath: null,
    installFolder: null,
    installedSizeInBytes: null,
    installerSizeInBytes: null,
  });

  logger.info(`[uninstallGame] Uninstalled ${objectId}`);

  return { ok: true };
};

registerEvent("uninstallGame", uninstallGame);
