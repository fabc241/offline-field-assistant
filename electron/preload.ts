/**
 * Runs in the sandboxed renderer before its page: exposes `window.ofa`, the
 * only way the page reaches the services (see src/app/contract.ts). The page
 * gets no Node, no Electron and no ipcRenderer of its own.
 *
 * Bundled to build/preload.cjs (sandboxed preloads must be CommonJS). The
 * channel names repeat IPC_INVOKE / IPC_EVENT from the contract so the
 * contract's runtime code (zod) stays out of the renderer.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppEvent, OfaApi } from '../src/app/contract.js'

let calls = 0

const api: OfaApi = {
  invoke: (channel, request, opts) => ipcRenderer.invoke('ofa:invoke', channel, request, opts?.callId ?? `call-${++calls}`),
  onEvent(listener) {
    const handler = (_e: IpcRendererEvent, event: AppEvent) => listener(event)
    ipcRenderer.on('ofa:event', handler)
    return () => ipcRenderer.removeListener('ofa:event', handler)
  }
}

contextBridge.exposeInMainWorld('ofa', api)
