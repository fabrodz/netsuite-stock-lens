/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
