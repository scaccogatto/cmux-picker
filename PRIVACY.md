# Privacy policy

cmux picker (the Chrome extension and its native messaging host) does not collect, store or transmit personal data to the developer or to any third party. There are no analytics, no telemetry, no accounts and no remote code.

## What the extension reads

Nothing is read from any page until you trigger the picker on it (the keyboard shortcut or the toolbar icon). When you pick an element and send it, the extension reads from the current page: the page URL, the element's selector path, its trimmed HTML, computed styles, position and viewport size, the prompt you typed and, only when you switch the option on, a screenshot of the element cropped from the visible tab.

## Where it goes

That data is handed to the native messaging host, a process on your computer that Chrome starts and that only this extension can reach. The host connects to cmux through cmux's local Unix socket on your machine, as a paste to the terminal surface you chose. Screenshots and oversized snippets are written to a temporary directory on your machine (`cmux-picker` under the system temp directory) so the agent can read them; the host deletes files older than 24 hours each time it starts.

No data is sent to the developer, to any server or to any third party. What the agent does with the prompt is governed by that agent and by cmux, both running under your account on your machine.

## Socket access control

cmux's Unix socket respects the user's socket control mode setting in cmux Settings > Automation. In "Automation mode" any local process of your user account can reach the socket; in "Password mode" a process must also present the password stored in your cmux state directory. In the default "cmuxOnly" mode, only processes started inside cmux terminals can connect. This extension runs as a process spawned by Chrome outside cmux, so it needs the mode to be changed from the default.

## What is stored in the browser

Two preferences, in the page's own localStorage, per site: the last agent you targeted and whether the screenshot option is on. Nothing else is stored.

## Changes and contact

Changes to this policy are recorded in this repository's history. Questions: https://github.com/scaccogatto/cmux-picker/issues
