import React from "react";
import { createRoot } from "react-dom/client";

import { CommunityMap } from "./components/community-map";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing app root");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <CommunityMap />
  </React.StrictMode>,
);
