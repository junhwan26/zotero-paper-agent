import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  registerPaperChatSection,
  unregisterPaperChatSection,
} from "./modules/paperChat";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPreferencePane();
  registerPaperChatSection();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  ensureStyleSheet(win);
}

function ensureStyleSheet(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const href = `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`;

  const existing = doc.querySelector(
    `link[rel="stylesheet"][href="${href}"]`,
  ) as HTMLLinkElement | null;
  if (existing) {
    return;
  }

  const link = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href,
    },
  });

  doc.documentElement?.appendChild(link);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  unregisterPaperChatSection();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  // no-op
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      break;
  }
}

function onShortcuts(_type: string) {
  // no-op
}

function onDialogEvents(_type: string) {
  // no-op
}

function registerPreferencePane() {
  try {
    Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: "Paper Agent",
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    });
  } catch (error) {
    ztoolkit.log("Preference pane registration skipped", error);
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
