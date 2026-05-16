/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/popup/index.css";
import { Popup } from "./Popup";

const container = document.getElementById("root");
if (!container) {
  throw new Error("popup root element missing");
}

createRoot(container).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
