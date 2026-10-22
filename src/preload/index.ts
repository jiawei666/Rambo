import { contextBridge, ipcRenderer } from 'electron';
import type { RamboAPI, AppEvent } from '../shared/contracts';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`rambo:${method}`, ...args);
const api: RamboAPI = {
  snapshot: () => invoke('snapshot'),
  createBot: input => invoke('createBot', input),
  updateBot: (id, patch) => invoke('updateBot', id, patch),
  setBotArchived: (id, archived) => invoke('setBotArchived', id, archived),
  deleteBot: id => invoke('deleteBot', id),
  ensureBotChat: id => invoke('ensureBotChat', id),
  createGroup: input => invoke('createGroup', input),
  addGroupMembers: (id, botIds) => invoke('addGroupMembers', id, botIds),
  groupMemberChats: id => invoke('groupMemberChats', id),
  groupMessages: id => invoke('groupMessages', id),
  sendGroup: (id, text) => invoke('sendGroup', id, text),
  updateChat: (id, patch) => invoke('updateChat', id, patch),
  applyBotPermissionToChats: (id, permission) => invoke('applyBotPermissionToChats', id, permission),
  setRoutineStatus: (id, status) => invoke('setRoutineStatus', id, status),
  advanceRoutineScheduleForAcceptance: id => invoke('advanceRoutineScheduleForAcceptance', id),
  runRoutineNow: id => invoke('runRoutineNow', id),
  stopRoutineRun: id => invoke('stopRoutineRun', id),
  messages: id => invoke('messages', id),
  activities: id => invoke('activities', id),
  turns: id => invoke('turns', id),
  send: (id, text) => invoke('send', id, text),
  interrupt: id => invoke('interrupt', id),
  search: (query, botId) => invoke('search', query, botId),
  memories: id => invoke('memories', id),
  saveMemory: input => invoke('saveMemory', input),
  deleteMemory: id => invoke('deleteMemory', id),
  setSetting: (key, value) => invoke('setSetting', key, value),
  setLaunchAtLogin: enabled => invoke('setLaunchAtLogin', enabled),
  loginItemSystemChangesAllowed: () => invoke('loginItemSystemChangesAllowed'),
  injectAcceptanceEvent: event => invoke('injectAcceptanceEvent', event),
  account: () => invoke('account'),
  login: () => invoke('login'),
  models: () => invoke('models'),
  startVoice: (id, offerSdp) => invoke('startVoice', id, offerSdp),
  stopVoice: (id, reason) => invoke('stopVoice', id, reason),
  restartRuntime: () => invoke('restartRuntime'),
  onEvent(callback) {
    const listener = (_: unknown, event: AppEvent) => callback(event);
    ipcRenderer.on('rambo:event', listener);
    return () => ipcRenderer.removeListener('rambo:event', listener);
  }
};
contextBridge.exposeInMainWorld('rambo', api);
