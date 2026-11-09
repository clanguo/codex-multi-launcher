import { contextBridge, ipcRenderer } from "electron";
import type { AnnouncementLocale, CodexApi, CreateProfileInput, ReauthorizeSubscriptionProfileInput, RuntimeSnapshot, UpdateDownloadEvent } from "../shared/types.js";

const api: CodexApi = {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getAnnouncement: (locale?: AnnouncementLocale) => ipcRenderer.invoke("app:get-announcement", locale),
  setLanguage: (locale: AnnouncementLocale) => ipcRenderer.invoke("app:set-language", locale),
  dismissAnnouncement: (id: string) => ipcRenderer.invoke("app:dismiss-announcement", id),
  trackAnnouncementClick: (id: string) => ipcRenderer.invoke("app:track-announcement-click", id),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("app:download-update"),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  onUpdateEvent: (listener: (event: UpdateDownloadEvent) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: UpdateDownloadEvent) => listener(payload);
    ipcRenderer.on("app:update-event", wrappedListener);
    return () => ipcRenderer.removeListener("app:update-event", wrappedListener);
  },
  openExternalUrl: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  openOriginalCodex: () => ipcRenderer.invoke("app:open-original-codex"),
  getEnvironmentReport: () => ipcRenderer.invoke("environment:get"),
  getDefaultProfileEnvFile: () => ipcRenderer.invoke("profiles:default-env"),
  getDiagnosticsReport: () => ipcRenderer.invoke("diagnostics:get"),
  pickCodexAppPath: () => ipcRenderer.invoke("dialog:pick-codex-app-path"),
  pickLauncherDirectory: () => ipcRenderer.invoke("dialog:pick-launcher-directory"),
  revealPath: (path: string) => ipcRenderer.invoke("shell:reveal-path", path),
  listProfiles: (includeDeleted?: boolean) => ipcRenderer.invoke("profiles:list", includeDeleted),
  listConfigBackups: (profileId: string) => ipcRenderer.invoke("profiles:backups", profileId),
  restoreConfigBackup: (input) => ipcRenderer.invoke("profiles:restore-backup", input),
  getRuntimeStatus: () => ipcRenderer.invoke("profiles:runtime"),
  getRuntimeSnapshot: () => ipcRenderer.invoke("profiles:runtime-snapshot"),
  onRuntimeChanged: (listener: (snapshot: RuntimeSnapshot) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => listener(snapshot);
    ipcRenderer.on("profiles:runtime-changed", wrappedListener);
    return () => ipcRenderer.removeListener("profiles:runtime-changed", wrappedListener);
  },
  testProvider: (input) => ipcRenderer.invoke("provider:test", input),
  testProfileProvider: (input) => ipcRenderer.invoke("profiles:test-provider", input),
  listProviderModels: (input) => ipcRenderer.invoke("provider:models", input),
  listProfileProviderModels: (input) => ipcRenderer.invoke("profiles:models", input),
  startSubscriptionAuthorization: (input) => ipcRenderer.invoke("subscription-auth:start", input),
  pollSubscriptionAuthorization: (sessionId) => ipcRenderer.invoke("subscription-auth:poll", sessionId),
  cancelSubscriptionAuthorization: (sessionId) => ipcRenderer.invoke("subscription-auth:cancel", sessionId),
  createProfile: (input: CreateProfileInput) => ipcRenderer.invoke("profiles:create", input),
  updateProfile: (input) => ipcRenderer.invoke("profiles:update", input),
  reauthorizeSubscriptionProfile: (input: ReauthorizeSubscriptionProfileInput) => ipcRenderer.invoke("profiles:reauthorize-subscription", input),
  deleteProfile: (profileId: string) => ipcRenderer.invoke("profiles:delete", profileId),
  permanentlyDeleteProfile: (profileId: string) => ipcRenderer.invoke("profiles:delete-permanently", profileId),
  restoreProfile: (profileId: string) => ipcRenderer.invoke("profiles:restore", profileId),
  generateLauncher: (profileId: string) => ipcRenderer.invoke("profiles:generate-launcher", profileId),
  getProfileCliInfo: (profileId: string, refreshPath?: boolean) => ipcRenderer.invoke("profiles:cli-info", profileId, refreshPath),
  getProfileUsage: (profileId: string) => ipcRenderer.invoke("profiles:usage", profileId),
  openProfile: (profileId: string) => ipcRenderer.invoke("profiles:open", profileId),
  closeProfile: (profileId: string, force?: boolean) => ipcRenderer.invoke("profiles:close", profileId, force)
};

contextBridge.exposeInMainWorld("codexProfileManager", api);
