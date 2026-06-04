# mikser-io-post-pdf

HTML → PDF postprocessor for [mikser-io](https://github.com/almero-digital-marketing/mikser-io), driven by [puppeteer](https://pptr.dev/) or [puppeteer-core](https://www.npmjs.com/package/puppeteer-core).

Renders any layout that produces HTML through a headless chrome and emits a PDF. The plugin is small; the work is in two places — picking which chrome to drive (your bundled, a system install, or auto-detected), and a long-lived browser instance kept warm across renders.

## Install

Pick the install path that matches your environment.

**Local dev / quick start** — bundles a chrome download (~500 MB), works on any OS without extra setup:

```bash
npm install mikser-io-post-pdf puppeteer
```

**Headless production server** — uses your system chrome, no bundled download:

```bash
# 1. install a system chrome
sudo apt install -y google-chrome-stable

# 2. install the plugin + the lean driver (no chrome download)
npm install mikser-io-post-pdf puppeteer-core
```

The plugin accepts either driver — install whichever fits.

## Add to your config

```js
// mikser.config.js
export default {
    plugins: [
        'documents', 'layouts', 'render-hbs',
        'post-pdf',
    ],
    'post-pdf': {
        // 'auto' probes platform-typical chrome paths so the same
        // config works on macOS dev and Linux prod. Or set an
        // explicit path: '/usr/bin/google-chrome-stable'.
        executable: 'auto',
    },
}
```

Any layout filename of the shape `<name>.html-pdf.<engine>` (e.g. `report.html-pdf.hbs`) is rendered through your chosen template engine to HTML, then post-processed by this plugin to a PDF at `<name>.pdf` in the output folder.

## `executable` — picking which chrome to drive

Resolution precedence, in order. First match wins:

1. **`config.launch.executablePath`** — the puppeteer-native field. Use for full control of every `puppeteer.launch()` option.
2. **`config.executable`** — friendly top-level alias for the path.
3. **`PUPPETEER_EXECUTABLE_PATH` env var** — puppeteer's standard env override. Useful for per-server overrides without touching config.
4. **`config.executable: 'auto'`** — probes platform-appropriate locations and uses the first found. The recommended cross-OS default.
5. **Nothing set** — falls back to puppeteer's bundled chrome (only available when you installed `puppeteer`, not `puppeteer-core`).

### What `'auto'` probes

**macOS:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then Chrome Beta/Dev/Canary, Chromium, Microsoft Edge, Brave Browser.

**Linux:** `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/usr/bin/microsoft-edge-stable`, `/usr/bin/microsoft-edge`, `/snap/bin/chromium`.

**Windows:** `C:\Program Files\Google\Chrome\Application\chrome.exe`, the x86 variant, then Microsoft Edge in both paths.

If `'auto'` finds nothing, the plugin throws an actionable error listing every path it tried so you know what to install or where to put it. For non-standard installs (Homebrew chromium, `/opt/chrome/...`, etc.), set an explicit path — it always wins over `'auto'`.

## `config` shape (all optional)

```js
'post-pdf': {
    // pick chrome (see above)
    executable: 'auto',

    // full puppeteer.launch() options when you need more than `executable`.
    // launch.executablePath wins over launch.executable when both are present.
    launch: {
        args: ['--font-render-hinting=none'],   // merged with defaults
        // headless, executablePath are managed by the plugin
    },

    // forwarded to page.goto() for each render
    navigation: {
        waitUntil: 'networkidle0',   // default
        timeout: 30000,
    },

    // forwarded to page.pdf() for each render
    pdf: {
        format: 'A4',                // default
        printBackground: true,       // default
        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    },

    // when running with --watch, the browser is kept warm between
    // builds. Closed after this many idle ms (default: 60_000).
    teardownDelay: 60_000,
}
```

## Default chrome flags

`--no-sandbox` and `--disable-setuid-sandbox` are applied by default because most headless Linux servers and Docker images can't set up Chrome's sandbox. They're merged (deduped) with any `launch.args` you supply, so adding `--font-render-hinting=none` doesn't drop them. To run with the sandbox, override `launch.args` explicitly.

## How chrome is kept warm

One puppeteer browser instance is launched at startup. Every render opens a fresh page in that browser and closes it after `page.pdf()`. In `--watch` mode, the browser stays open between build cycles; the plugin schedules a teardown `teardownDelay` ms after the last render. In one-shot mode the browser closes immediately after the build.

## License

MIT.
