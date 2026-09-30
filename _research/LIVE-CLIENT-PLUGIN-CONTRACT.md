# DSH browser (client) plugin contract — verified report

Research target per request: `D:\workspace\deepseek-harness-master`.
**Critical version fork found:** the checkout is **0.1.0-rc.5**; the running app
(`D:\rj\dsh\resources\app.asar`) is **0.2.0-rc.2**. `sidebar.panellist` and keyed `main`
exist **only in the live app**, not in the checkout.

Live bundles were extracted (read-only) for citation to
`D:\workspace\dsh-plugin\_research\live-asar\...` and `_research\live-shell\...`
(helpers: `_research\extract-live-asar.mjs`, `list-asar-packages.mjs`, `scan-asar-string.mjs`).

Client Inspect providers (`Slots.listSubTree`, `Theme.listTokens`) timed out 3x
("Open or reconnect the Harness page") — no page was connected as an Inspect client,
so the live catalog came from the built bundles instead.

---

## 0. Platform seed words (what `require(...)` resolves)

Live, exact — `_research\live-shell\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-5SrrfWpU.js:126`:

```js
function rM(){return{
  react:Ef, "react/jsx-runtime":If, "react-dom":Rf, "react-dom/client":Df,
  "@deepseek-ai/cordis":sf,
  "@deepseek-ai/dsh-client-store":lh,
  "@deepseek-ai/dsh-client-ui-slots":hh,
  "@deepseek-ai/dsh-client-ui-primitives":sE,
  "@deepseek-ai/dsh-client-ui-dockkit":XS}}
```

Master (0.1.0-rc.5) list — `packages/client/web/src/platform.ts:8-15` — is different:
`...web-react`, `...ui-attachment`, `...schema-form` instead of `...dsh-client-store` / `...ui-dockkit`.

Resolution order — `packages/client/modules/src/client/system.ts:142-156`: seed → shell statics →
memoized record → **any registered factory (i.e. any enabled client plugin package id)** → throw.

---

## 1. `ctx.slots.register(...)`

- Contract/types: `@deepseek-ai/dsh-client-ui-slots` (`SlotCore.register`).
- Runtime service: `ctx.slots` (`SlotRegistry`). Master: `packages/client/runtime/src/client/slots.ts:126`, `:464`.
  Live: inside `@deepseek-ai/dsh-client-ui-renderer` (`...ui-renderer\lib\client.js:1578` register, `:1343` inject, `:1440` provideRoot).

```ts
ctx.slots.register(options, Component): () => void   // idempotent disposer
ctx.slots.inject(key, () => ctx.slots.register(...)): () => void
```

Kind options (master `ui-slots/src/index.ts:485-509`; live `ui-slots\lib\index.js:176-184, 207-210`):

| kind | required | optional |
|---|---|---|
| `list` | `id: string` | `order?: number` (ascending, default 0), `label?: string \| (() => string)`, `priority?: number` |
| `keyed` | `key: string` | `priority?: number` |
| `single` | — | `priority?: number` (shadowing rank) |
| `chain` | `select` | `priority?: number` |

Common options: `{ name, children?, store?, locale?, inject?, registrant? }`.
`label` may be a thunk so nav text follows the locale (`resolveSlotLabel`, master `index.ts:474/581`, live `lib/index.js:27`).
Same `id`/`key` at the same priority throws ("already has an entry…"); lower `priority` renders.
Registering into an undeclared slot throws `slot "X" is not declared…`.
`ctx.slots.inject(key, cb)` is mandatory when the slot is declared by *another* plugin: it waits for
the declaration and re-arms after collapse — this is the shipped pattern everywhere.

---

## 2. The sidebar-icon → central-panel pair (live 0.2.0-rc.2)

- `sidebar.panellist` — **list, scope root**, owner props `{ size: number, active: boolean }`
  - declaration `...ui-sidebar\lib\client.js:503-506`
  - render `...ui-sidebar\lib\client.js:190-193`:
    `renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`
  - row click is shipped: `selectPanel(id)` → `ctx.layout.selectPanel(id)`
- `main` — **keyed, scope root, no `keyProps`, no owner props ({})**
  - declaration `...ui-layout\lib\client.js:609-612`
  - render `...ui-layout\lib\client.js:117-119`:
    `renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })`
  - `layout.selectPanel(id)` throws when no `main` entry has that key (`:462-466`)
- Selection hook: `ctx.slots.provideRoot({ hooks: { panelInfo } })` (`ui-layout...:599`) becomes the
  standard prop **`usePanelInfo`** on every slot component (naming `use`+Capitalized, live
  `ui-slots\lib\index.js:8`).

Real shipped pair — `@deepseek-ai/dsh-client-ui-schedule` (`...ui-schedule\lib\client.js`):

```js
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main", key: PANEL_ID, locale: MANAGER_NS,
  inject: () => ({ ...detail, onNewTask: () => { ctx.uiWorkspace.startSession(); } })
}, TaskManagerPage));                                    // :5965  (PANEL_ID="schedules" :6683)

ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 10, locale: MANAGER_NS,
  label: () => t("panel")
}, TaskManagerIcon));                                    // :6196  function TaskManagerIcon({ size })
```

Fallback if the bundle must also run on the 0.1.0-rc.5 checkout: that tree has neither key; its only
additive root-scoped seats are `shell.overlay` (list, root, owner `{}`) and
`sidebar.footer.action` (list, root, owner `{ wide }`) — nothing selects a central panel there.

---

## 3. Module shape

Named `inject` + `apply`; entry name comes from the loader/package, **not** from exports.
Never `export default` (`docs/postmortem/0001-acp-default-export-drops-inject.md:39-54` — `unwrapExports`
prefers `.default` and discards `inject`/`name`).

```js
window.__ModuleLoader__.load({
  id: "<package-name>",                       // MUST equal the loader entry / graph row id
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    /* ... */
    exports.apply = apply; exports.inject = inject; return module.exports;
  }
});
```

Live reference: `...ui-layout\lib\client.js:1-9` (head) and `:687-691` (tail).
`<id>/client` normalizes to the same module (`packages/client/modules/README.md:7`).
Registration alone does not create a loader entry — the host must scan the package as a
`dsh.client` web entry (`package.json` `dsh.client.platform = "web"` + `exports["./client"]`,
live example `...ui-layout\package.json:16-39`).

---

## 4. Theme tokens

No CSS-module import required: tokens are plain custom properties on `:root`/`body`
(and `body[data-ds-dark-theme]`) in the live ui-theme bundle
(`...ui-theme\lib\client.js`, `--dsw-alias-bg-base:` near char 54668). `var(--dsw-alias-*)` in an
inline style resolves. Rule (`docs/web-styling.md:16-20`): use `--dsw-alias-*` semantic tokens,
never literal colors; inline styles may not encode theme branches.

Live inventory: 403 distinct `--dsw-*` names. Useful aliases:
`--dsw-alias-bg-base`, `-bg-layer-1/2/3`, `-bg-overlay`, `-border-l1/l2/l3/l4`,
`-brand-primary`, `-label-primary/secondary/tertiary`, `-interactive-bg-hover`,
`-state-error/success/warn-primary`, `-specific-sidebar-fill`,
`--dsw-radius-sm/md/lg/panel`, `--dsw-font-s-14-font-family|-font-size|-line-height`,
`--dsw-focus-ring-color`, `--dsw-shadow-lv1`, `--dsw-elevation-panel`.

---

## 5. Periodic data fetching

- `@deepseek-ai/dsh-client-web-react` (master only) exports `bindSnapshotSelector`, `createSlotRenderer`,
  `SessionProvider`, `useInvoke`, exceptions + types (`packages/client/web-react/src/index.ts:1-23`).
  **No** `useService`/`useSnapshot`/`defineStore`. The package does not exist in the live app.
- Store engine live: `@deepseek-ai/dsh-client-store` — `defineStore({init, actions, persist?})`,
  `createSnapshotStore(init, {flush:'raf'|'sync', persist})` → `{getSnapshot, subscribe, update, set}`
  (`...dsh-client-store\lib\index.js:70-102, 147-176`).
- Store seat: `register({ ..., store }, C)` → `C` gets `useStore(selector)` + baked `actions`
  (live `ui-renderer\lib\client.js:729, 936`).
- Standard props on every slot component: `useSessions`, `useWorkspaces`, `usePanelInfo`;
  `session` scope adds `useSession`, `sessionId`, `useProjection`; `session-maybe` optional variants;
  ui-conversation adds `useInput`/`inputActions`.
- Timers: a real plugin may use `window.setInterval`/`clearInterval` (only dynamic-runner packages trap them).
- Host RPC: `ctx.remote.<namespace>.<method>(...)` (`docs/api-gateway.md:72`); the namespace must be
  mounted by the client assembly. Self-serve registration for an out-of-tree host half: **not verified**.

---

## 6. Paste-ready bundle

```js
window.__ModuleLoader__.load({
  id: "my-dashboard-plugin",              // MUST equal the loader entry / package name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");         // platform seed word
    var PANEL_ID = "my-dashboard";        // panellist `id` == main `key`

    // (b) sidebar icon — owner props { size, active } + standard kit
    function DashboardIcon(props) {
      var size = typeof props.size === "number" ? props.size : 18;
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 16 16",
        "aria-hidden": "true", focusable: "false",
        style: { display: "block", color: props.active ? "var(--dsw-alias-brand-primary)" : "currentColor" }
      },
        React.createElement("rect", { x: 1.75, y: 1.75, width: 12.5, height: 12.5, rx: 3,
          fill: "none", stroke: "currentColor", strokeWidth: 1.25 }),
        React.createElement("path", { d: "M2 6.25h12M6.5 6.25v8",
          fill: "none", stroke: "currentColor", strokeWidth: 1.25 }));
    }

    // (b) central panel — standard kit + this registration's inject face, no owner props
    function DashboardPanel(props) {
      var fetchStats = props.fetchStats;
      var state = React.useState({ status: "loading", value: null, error: null });
      var snapshot = state[0], setSnapshot = state[1];

      React.useEffect(function () {
        var cancelled = false;
        var tick = function () {
          fetchStats().then(
            function (value) { if (!cancelled) setSnapshot({ status: "ready", value: value, error: null }); },
            function (error) { if (!cancelled) setSnapshot({ status: "error", value: null, error: String((error && error.message) || error) }); });
        };
        tick();
        var timer = window.setInterval(tick, 5000);
        return function () { cancelled = true; window.clearInterval(timer); };
      }, [fetchStats]);

      var body = snapshot.status === "loading" ? "Loading…"
        : snapshot.status === "error" ? "Failed: " + snapshot.error
          : JSON.stringify(snapshot.value, null, 2);

      return React.createElement("div", {
        style: {
          boxSizing: "border-box", height: "100%", overflow: "auto",
          padding: "16px 20px",
          background: "var(--dsw-alias-bg-base)",
          color: "var(--dsw-alias-label-primary)",
          fontFamily: "var(--dsw-font-s-14-font-family)",
          fontSize: "var(--dsw-font-s-14-font-size)",
          lineHeight: "var(--dsw-font-s-14-line-height)"
        }
      },
        React.createElement("div", {
          style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px", fontWeight: 600 }
        }, "Dashboard"),
        React.createElement("pre", {
          style: {
            margin: 0, padding: "12px",
            background: "var(--dsw-alias-bg-layer-2)",
            border: "1px solid var(--dsw-alias-border-l1)",
            borderRadius: "var(--dsw-radius-md)",
            whiteSpace: "pre-wrap", wordBreak: "break-word"
          }
        }, body));
    }

    exports.inject = ["slots", "layout"];
    exports.apply = function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({
          name: "sidebar.panellist", id: PANEL_ID, order: 100, label: "Dashboard"
        }, DashboardIcon);
      });

      ctx.slots.inject("main", function () {
        return ctx.slots.register({
          name: "main", key: PANEL_ID,
          inject: function () {
            return {
              fetchStats: function () {
                // Fill in: ctx.remote.<namespace>.<method>() (needs a mounted Remote
                // contribution) or a same-origin route served by your host half.
                return Promise.resolve({ ok: true, at: new Date().toISOString() });
              }
            };
          }
        }, DashboardPanel);
      });
    };

    return module.exports;
  }
});
```

---

## 7. Explicitly unverified / caveats

1. Live Inspect catalog could not be queried (client timeout); slot facts come from the built
   live bundles, not from `Slots.listSubTree`. Exact line numbers are in `_research\live-asar`.
2. `sidebar.panellist` + `main` exist only in the live 0.2.0-rc.2 app; a bundle using them shows
   nothing on the 0.1.0-rc.5 checkout (`slots.inject` simply never fires there).
3. The live seed has no `@deepseek-ai/dsh-client-web-react` / `...ui-attachment` / `...schema-form`;
   requiring them would throw the loader's "missed the module table" error.
4. The host-side RPC path for an out-of-tree pair (how a `ctx.remote.<ns>` namespace gets mounted)
   was not verified.
5. Whether `label` may be omitted entirely for `sidebar.panellist` was not verified against live
   behaviour (the shipped sidebar falls back to the `id`; both shipped registrants pass a label).
6. Manual `window.__ModuleLoader__.load` registration does not create a loader entry by itself —
   the package must be a scanned `dsh.client` graph row, or nothing renders.
