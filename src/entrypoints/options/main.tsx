/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/options/index.css";
import { Options } from "./Options";

const container = document.getElementById("root");
if (!container) {
  throw new Error("options root element missing");
}

createRoot(container).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
