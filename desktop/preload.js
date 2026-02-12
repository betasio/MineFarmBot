'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('minefarmDesktop', {
  isDesktop: true,
  restartBot: () => ipcRenderer.invoke('desktop:restart-bot')
})
