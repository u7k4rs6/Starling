import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Step 16 (deploy): a GitHub Pages *project* site (not a user/org site)
// is served from https://<owner>.github.io/<repo>/, not the domain root —
// asset URLs built for "/" 404 one path segment short. GITHUB_PAGES is
// set only by .github/workflows/deploy-demo.yml; local `vite`/`vite build`
// (dev, e2e) keep the root base, unaffected.
export default defineConfig({
  base: process.env.GITHUB_PAGES === "true" ? "/Starling/" : "/",
  plugins: [react()],
});
