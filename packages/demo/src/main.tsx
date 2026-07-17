import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("demo: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
