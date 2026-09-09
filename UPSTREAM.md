# Upstream

This repository was created on 2026-09-09 by copying [herdr-picker](https://github.com/scaccogatto/herdr-picker) at commit `c36d749` and retargeting it from herdr to cmux. herdr-picker in turn copied its shared modules from [vite-plugin-herdr](https://github.com/scaccogatto/vite-plugin-herdr) at commit `f5ef5e1`.

There is no dependency between the three projects. Fixes are ported by hand.

| Here | herdr-picker | vite-plugin-herdr |
|---|---|---|
| `src/extension/picker.ts` | same | `src/client/index.ts` |
| `src/extension/dom.ts` | same | `src/client/dom.ts` |
| `src/extension/agents.ts` | same | `src/client/agents.ts` |
| `src/extension/crop.ts` | same | (extension only) |
| `src/compose.ts` | same | `src/compose.ts` |
| `src/types.ts` | same | `src/types.ts` |
| `src/validate.ts` | same | `src/http.ts` |
| `src/cmux.ts` | `src/herdr.ts` | `src/herdr.ts` |
| `src/bridge.ts` | same | `src/server.ts` |
| `src/native.ts`, `src/host.ts`, `src/cli.ts`, `src/host-name.ts` | same | (extension only) |
| `src/__tests__/helpers/fake-cmux.ts` | `helpers/fake-herdr.ts` | `helpers/fake-herdr.ts` |

The transport (`src/cmux.ts`), the state and prompt bridge (`src/bridge.ts`), the agent shapes in `src/types.ts` and the socket test double were rewritten for cmux's v2 socket protocol; everything else is the herdr-picker code with `herdr` renamed to `cmux`.

Nothing in this repository is copied from cmux itself (GPL-3.0). The native host only speaks cmux's documented control-socket protocol.
