'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('minefarmDesktop', {
  isDesktop: true,
  restartBot: () => ipcRenderer.invoke('desktop:restart-bot'),
  listProfiles: () => ipcRenderer.invoke('desktop:list-profiles'),
  createProfile: (payload) => ipcRenderer.invoke('desktop:create-profile', payload),
  launchProfile: (profileId) => ipcRenderer.invoke('desktop:launch-profile', profileId),
  stopBot: () => ipcRenderer.invoke('desktop:stop-bot'),
  onAuthCode: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('desktop:msa-code', listener)
    return () => ipcRenderer.removeListener('desktop:msa-code', listener)
  }
})
