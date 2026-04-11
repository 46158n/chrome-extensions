# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository structure

Each extension lives under `extensions/<name>/` as a self-contained Chrome Extension (Manifest V3). There is no monorepo tooling or shared build step — extensions are plain files loaded directly into Chrome.

## Loading / reloading an extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extensions/<name>/`
4. After editing files, click the reload icon on the extension card

There is no build step for extensions that use only declarative APIs (`declarativeNetRequest`). Extensions that include a service worker (`background.js`) also require no build step.

## Architecture conventions

- **Prefer `declarativeNetRequest` over `webNavigation` + `tabs.update`** for URL rewriting. It intercepts at the network layer before any request is made, requires no service worker, and avoids wake-up latency.
- `rules.json` contains static redirect/block rules referenced from `manifest.json` under `declarative_net_request.rule_resources`.
- Only add a `background.js` service worker when logic cannot be expressed declaratively.
- Keep `host_permissions` scoped to only the domains the extension actually touches.

## Adding a new extension

Create `extensions/<name>/manifest.json` with `"manifest_version": 3`. No scaffolding script exists — copy an existing extension as a starting point.
