import "@fontsource/jetbrains-mono/300.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initialTheme } from "./theme.js";
import "./style.css";

// Set the theme before the first paint so there is no flash of the wrong palette.
document.documentElement.dataset.theme = initialTheme();

const root = document.getElementById("root");
if (!root) throw new Error("demo: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
