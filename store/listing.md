# Chrome Web Store listing

Copy-paste source for the developer dashboard. Keep it in sync with `README.md` and `extension/manifest.json`. The PNGs in this directory come from `npm run store-assets` (Playwright against the built extension and the fake cmux).

## Developer account, once

- One-time registration fee (5 USD) at https://chrome.google.com/webstore/devconsole
- Google account with 2-Step Verification on
- Account tab: verified contact email; privacy policy field = https://github.com/scaccogatto/cmux-picker/blob/main/PRIVACY.md (must match the item's); trader / non-trader declaration (EU Digital Services Act, required before the listing is visible in the EU)

## Package tab

| Upload | Zip |
|---|---|
| First draft, to harvest the Store key | `cmux-picker-<version>-store.zip`, built without the manifest `key` (steps in `.okf/release.md`) |
| Every later upload | `cmux-picker-<version>.zip`, the plain `dist/extension/` |

## Store listing tab

| Field | Value |
|---|---|
| Title | `cmux picker` (manifest `name`, not editable here) |
| Summary | manifest `description`, not editable here: "Pick an element on any page and send it, with a prompt, to a coding agent running in cmux." |
| Detailed description | below |
| Category | Developer Tools |
| Language | English |
| Store icon | `store/icon-128.png` (96 px artwork, 16 px transparent padding) |
| Screenshots | `store/screenshot-1.png` (hover outline and chip), `store/screenshot-2.png` (popup with a prompt), `store/screenshot-3.png` (agents grouped by workspace); 1280x800 |
| Small promo tile | `store/tile-440x280.png` |
| Marquee promo tile, YouTube video | none |
| Official URL | none (needs a verified domain) |
| Homepage URL | https://github.com/scaccogatto/cmux-picker |
| Support URL | https://github.com/scaccogatto/cmux-picker/issues |
| Mature content | No |

### Detailed description

```
cmux picker lets you point at any element on any page and hand it, with a prompt, to a coding agent running in cmux on your own machine.

Press Ctrl+B (Control+B on macOS) or click the toolbar icon. Hover to outline elements, click to pick one, Shift+click to select up to five. Type what you want changed and press Enter: your prompt lands as one bracketed paste in the agent's terminal, followed by a Return keystroke. The agent you chose receives the element's selector path, its trimmed HTML, computed styles, viewport and position, a source hint when the page carries one (locator attributes or a Vue dev runtime; React's dev runtime gives the component name only) and, if you switch it on, a real-pixel screenshot of the element.

It works on every page you browse: your own apps under any framework or server, staging, production, third-party sites as a visual reference.

WHAT YOU NEED
• macOS with cmux installed (https://cmux.com).
• cmux Settings > Automation set to "Automation mode" or "Password mode" (the default "cmuxOnly" mode rejects external processes).
• For agent status and the spawn rows: Claude Code integration enabled in cmux Settings, and/or hooks configured for other agents via "cmux hooks setup <agent>".
• The native messaging host, installed once: npx cmux-picker install-host.

HOW IT REACHES CMUX
Chrome starts a small local process, the native messaging host, that only this extension can talk to. The host sends your prompt to cmux's local Unix socket. No localhost port, no token, no server, no account: nothing leaves your machine.

CHOOSE THE AGENT
The To field lists the agents cmux is running, grouped by workspace, and remembers the last one you used on that site. "+ agent here" opens a new agent split next to cmux's focused surface; "+ agent in worktree" starts one in a fresh git worktree (requires the Claude Code integration). Blocked agents are listed but cannot be targeted. While the agent works, the picked element keeps its outline until the agent settles (idle, working, or blocked), polling cmux's state every 2 seconds.

If the host is not installed, cmux is not running, or the socket mode is set to cmuxOnly, the prompt is copied to your clipboard instead, with the reason shown in the popup.

Open source (MIT): https://github.com/scaccogatto/cmux-picker
For pages you serve with Vite there is vite-plugin-herdr: same picker, no extension needed.
```

## Privacy practices tab

**Single purpose**

```
Send a DOM element the user picks on the current page, with a prompt, to a coding agent running in cmux on the user's own machine.
```

**Permission justifications**

activeTab:

```
Granted only when the user presses the extension's shortcut or clicks its toolbar icon. It lets the extension inject the picker into that tab and, when the user switches the screenshot option on, capture the tab's visible area to crop the picked element. No host permissions are declared: nothing runs on any page until the user asks.
```

scripting:

```
Injects the picker script (content.js, bundled in the package) into the active tab on the user's gesture. No content_scripts are registered in the manifest, so no page is touched automatically.
```

nativeMessaging:

```
Connects to the local native messaging host the user installs with "npx cmux-picker install-host". The host relays the picked element and the prompt to cmux's Unix socket on the user's machine. It is the extension's only channel out; there is no server.
```

Host permissions: none declared, the field stays empty.

**Remote code**: "No, I am not using remote code" (every script is bundled in the package; no eval, no remote scripts).

**Data usage**, "What user data do you plan to collect?": check only **Website content**; everything else unchecked.

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**: https://github.com/scaccogatto/cmux-picker/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public. Distribution: all regions. Payments: free.
