/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
export default defineBackground(() => {
  const version = browser.runtime.getManifest().version;
  console.info(`[nsl] background service worker startup v${version}`);

  browser.runtime.onInstalled.addListener(() => {
    console.info(`[nsl] installed v${version}`);
  });
});
