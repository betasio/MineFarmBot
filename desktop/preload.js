'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('minefarmDesktop', {
  isDesktop: true,
  restartBot: () => ipcRenderer.invoke('desktop:restart-bot'),
  listProfiles: () => ipcRenderer.invoke('desktop:list-profiles'),
  createProfile: (payload) => ipcRenderer.invoke('desktop:create-profile', payload),
  launchProfile: (profileId) => ipcRenderer.invoke('desktop:launch-profile', profileId),
  stopBot: () => ipcRenderer.invoke('desktop:stop-bot'),
  exportDiagnostics: (profileId) => ipcRenderer.invoke('desktop:export-diagnostics', profileId),
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:status', listener)
    return () => ipcRenderer.removeListener('desktop:status', listener)
  },
  onStatusTransition: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:status-transition', listener)
    return () => ipcRenderer.removeListener('desktop:status-transition', listener)
  },
  onLog: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:log', listener)
    return () => ipcRenderer.removeListener('desktop:log', listener)
  },
  onWarning: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:warning', listener)
    return () => ipcRenderer.removeListener('desktop:warning', listener)
  },
  onError: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:error', listener)
    return () => ipcRenderer.removeListener('desktop:error', listener)
  },
  onAuthCode: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:msa-code', listener)
    return () => ipcRenderer.removeListener('desktop:msa-code', listener)
  }
})
