import { ColumnOptions } from "zotero-plugin-toolkit";

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [] as Array<ColumnOptions>,
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }

  bindToggleApiKey(_window);
  bindLocalModeHints(_window);
}

function bindToggleApiKey(win: Window) {
  const doc = win.document;
  const toggle = doc.querySelector(
    `#zotero-prefpane-${addon.data.config.addonRef}-show-api-key`,
  ) as HTMLInputElement | null;
  const input = doc.querySelector(
    `#zotero-prefpane-${addon.data.config.addonRef}-llm-api-key`,
  ) as HTMLInputElement | null;

  if (!toggle || !input || toggle.dataset.bound === "true") {
    return;
  }

  toggle.dataset.bound = "true";
  toggle.addEventListener("command", () => {
    input.type = toggle.checked ? "text" : "password";
  });
}

function bindLocalModeHints(win: Window) {
  const doc = win.document;
  const localMode = doc.querySelector(
    `#zotero-prefpane-${addon.data.config.addonRef}-local-mode`,
  ) as HTMLInputElement | null;
  const apiKey = doc.querySelector(
    `#zotero-prefpane-${addon.data.config.addonRef}-llm-api-key`,
  ) as HTMLInputElement | null;

  if (!localMode || !apiKey || localMode.dataset.bound === "true") {
    return;
  }

  localMode.dataset.bound = "true";
  const sync = () => {
    apiKey.placeholder = localMode.checked
      ? "Optional in local mode"
      : "Required for cloud APIs";
  };

  sync();
  localMode.addEventListener("command", sync);
}
