import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('ub', {
  platform: 'electron',
  pickFolder: () => ipcRenderer.invoke('ub:pickFolder'),
  call: (method: string, params: unknown) => ipcRenderer.invoke('ub:call', method, params),
  recent: () => ipcRenderer.invoke('ub:recent'),
  forgetRecent: (root: string) => ipcRenderer.invoke('ub:forgetRecent', root),
  openInEditor: (file: string, line?: number) => ipcRenderer.invoke('ub:openInEditor', file, line),
  reveal: (file: string) => ipcRenderer.invoke('ub:reveal', file),
  onProgress: (cb: (p: unknown) => void) => {
    const fn = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('ub:progress', fn);
    return () => ipcRenderer.removeListener('ub:progress', fn);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onEvent: (cb: (e: unknown) => void) => {
    const fn = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on('ub:event', fn);
    return () => ipcRenderer.removeListener('ub:event', fn);
  },
  initialFolder: () => ipcRenderer.invoke('ub:initialFolder'),
});
