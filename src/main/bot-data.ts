import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, sep } from 'node:path';

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Remove only the app-managed directory belonging to one Bot. */
export function removeManagedBotDirectory(storeDirectory: string, botId: string): void {
  if (!botId || botId === '.' || botId === '..' || botId.includes('/') || botId.includes('\\') || botId.includes('\0')) {
    throw new Error('Bot 标识不能用于定位专属工作区');
  }
  const botsDirectory = join(storeDirectory, 'bots');
  const botDirectory = join(botsDirectory, botId);
  if (basename(botDirectory) !== botId) throw new Error('Bot 专属工作区路径无效');
  if (!exists(botsDirectory)) return;
  const botsStat = lstatSync(botsDirectory);
  if (!botsStat.isDirectory() || botsStat.isSymbolicLink()) {
    throw new Error('Bot 数据目录不是受信任的应用目录，已停止清理');
  }
  if (!exists(botDirectory)) return;
  const botStat = lstatSync(botDirectory);
  if (!botStat.isDirectory() || botStat.isSymbolicLink()) {
    throw new Error('Bot 专属目录不是受信任的应用目录，已停止清理');
  }
  const realBotsDirectory = realpathSync(botsDirectory);
  const realBotDirectory = realpathSync(botDirectory);
  if (realBotDirectory !== join(realBotsDirectory, botId) || !realBotDirectory.startsWith(realBotsDirectory + sep)) {
    throw new Error('Bot 专属目录越出应用管理范围，已停止清理');
  }
  rmSync(botDirectory, { recursive: true, force: false });
}
