import path from 'node:path'
import { access } from 'node:fs/promises'

// Declare the produced file extension so mikser-io can compute the
// destination correctly. For pdf the name and the extension coincide,
// but stating it explicitly mirrors the post-mjml shape.
export const output = 'pdf'

const TEARDOWN_DELAY = 60_000

let browser
let teardownTimer

// Platform-appropriate paths where Chrome / Chromium / Edge typically
// live when installed via the OS package manager (apt / dmg / msi).
// Order matters — first existing one wins. `executable: 'auto'` probes
// this list so the same mikser.config.js works on a Mac dev box and a
// Linux production server without env-conditional path strings.
function chromeCandidates() {
    if (process.platform === 'darwin') return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    if (process.platform === 'win32') return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    // linux + everything else
    return [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/microsoft-edge',
        '/snap/bin/chromium',
    ]
}

async function discoverSystemChrome() {
    for (const candidate of chromeCandidates()) {
        try {
            await access(candidate)
            return candidate
        } catch { /* not there, try next */ }
    }
    return null
}

export async function setup({ config, logger }) {
    if (teardownTimer) {
        clearTimeout(teardownTimer)
        teardownTimer = undefined
        logger.debug('Puppeteer browser reused')
        return
    }

    // Resolve which chrome to use, in precedence order:
    //   1. config.launch.executablePath  — explicit, wins
    //   2. config.executable (literal path) — friendly top-level alias
    //   3. PUPPETEER_EXECUTABLE_PATH     — puppeteer's standard env var
    //   4. config.executable === 'auto'  → probe OS-typical chrome paths
    //                                      (cross-platform default —
    //                                      same config works on macOS
    //                                      dev + Linux prod)
    //   5. undefined → puppeteer's bundled download
    //
    // 'auto' is the recommended setting when the same project is
    // deployed across OSes. It avoids env-conditional config strings
    // like (process.platform === 'darwin' ? '/Applications/...' : '/usr/bin/...').
    const aliased = config?.executable
    let executablePath = config?.launch?.executablePath
    if (executablePath === undefined) {
        if (aliased !== undefined && aliased !== 'auto') {
            // Literal config.executable (including '' — that's a config
            // bug but we surface it via puppeteer's launch error rather
            // than silently falling through to env).
            executablePath = aliased
        } else if (process.env.PUPPETEER_EXECUTABLE_PATH !== undefined) {
            executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
        } else if (aliased === 'auto') {
            executablePath = await discoverSystemChrome()
            if (!executablePath) {
                const tried = chromeCandidates().map(p => '    ' + p).join('\n')
                throw new Error(
                    `post-pdf: 'executable: \\'auto\\'' was configured but no system chrome was found on ${process.platform}.\n` +
                    `Tried:\n${tried}\n` +
                    `Install one of the above OR set 'executable' to an explicit path.`
                )
            }
            logger.debug('Auto-discovered chrome: %s', executablePath)
        }
    }

    // Driver library: prefer `puppeteer` (bundles chrome — works without
    // an executablePath). Fall back to `puppeteer-core` (lean, no chrome
    // download — requires an explicit executable). Track which one
    // loaded so the no-executable case can fail early with a clear
    // message instead of letting puppeteer-core surface its own
    // "executablePath or channel must be specified" error.
    let puppeteer = await import('puppeteer').then(m => m.default).catch(() => null)
    let driver = puppeteer ? 'puppeteer' : null
    if (!puppeteer) {
        puppeteer = await import('puppeteer-core').then(m => m.default).catch(() => null)
        if (puppeteer) driver = 'puppeteer-core'
    }

    if (!puppeteer) {
        // No driver at all. Context-aware install instructions: if the
        // operator already configured an executable, puppeteer-core is
        // the right install (lean, no chrome download). Otherwise either
        // works.
        if (executablePath) {
            throw new Error(
                `post-pdf needs the puppeteer driver library to talk to chrome at ${executablePath}.\n` +
                `Since you've configured an external executable, install the lean driver (no bundled chrome):\n` +
                `  npm install puppeteer-core`
            )
        }
        throw new Error(
            'post-pdf needs a puppeteer driver to render PDFs.\n' +
            'Two options:\n' +
            '  - Quickest:   npm install puppeteer            (bundles chrome ~500MB)\n' +
            '  - Headless:   sudo apt install google-chrome-stable\n' +
            '                npm install puppeteer-core      (no chrome download)\n' +
            '                # then in mikser.config.js:\n' +
            "                'post-pdf': { executable: '/usr/bin/google-chrome-stable' }"
        )
    }

    // puppeteer-core can't find chrome on its own. If it's what loaded
    // and no executable was resolved, fail here with a message naming
    // the actual fix — install `puppeteer` for bundled chrome, OR set
    // an `executable` path — instead of letting puppeteer-core surface
    // its native "An `executablePath` or `channel` must be specified"
    // error, which mentions puppeteer-core even when the operator never
    // chose it explicitly.
    if (driver === 'puppeteer-core' && !executablePath) {
        throw new Error(
            "post-pdf: only `puppeteer-core` is installed and no `executable` is configured.\n" +
            "puppeteer-core does not bundle chrome — it needs an explicit binary to drive. Either:\n" +
            "  - Install puppeteer alongside (downloads bundled chrome ~500MB):\n" +
            "      npm install puppeteer\n" +
            "  - Configure a chrome path in mikser.config.js:\n" +
            "      'post-pdf': { executable: 'auto' }                            // probes /usr/bin/google-chrome-stable, etc.\n" +
            "      'post-pdf': { executable: '/usr/bin/google-chrome-stable' }   // or an explicit path"
        )
    }

    // Default chrome flags for headless server / Docker contexts:
    //
    //   --no-sandbox / --disable-setuid-sandbox
    //       Most headless Linux servers and Docker images can't set up
    //       Chrome's sandbox. To run WITH the sandbox, override
    //       launch.args explicitly.
    //
    //   --disable-dev-shm-usage
    //       Chrome uses /dev/shm for V8 / IPC shared memory. Docker
    //       defaults /dev/shm to 64 MB; many VPS containers cap it at
    //       a few hundred MB. When chrome runs out, it dies silently
    //       during init — puppeteer waits and times out with
    //       "Timed out after 30000 ms while waiting for the WS endpoint
    //       URL to appear in stdout!" This flag tells chrome to use
    //       /tmp (regular disk) for shared memory instead.
    //
    // All three are merged (deduped) with any user-supplied
    // launch.args so callers can add flags without losing these.
    const defaultArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
    ]

    browser = await puppeteer.launch({
        headless: true,
        ...config?.launch,
        ...(executablePath ? { executablePath } : {}),
        args: [...new Set([...defaultArgs, ...(config?.launch?.args ?? [])])],
    })
    // Mention which driver loaded and where chrome came from so the
    // operator can tell at a glance whether they're on bundled or
    // external chrome.
    if (executablePath) {
        logger.debug('Puppeteer browser launched [%s] (executable: %s)', driver, executablePath)
    } else {
        logger.debug('Puppeteer browser launched [%s] (bundled chrome)', driver)
    }
}

export async function postprocess({ entity, options, config, logger }) {
    const sourcePath = path.join(options.outputFolder, entity.origin)

    const page = await browser.newPage()
    try {
        await page.goto(`file://${sourcePath}`, {
            waitUntil: 'networkidle0',
            ...config?.navigation
        })
        return await page.pdf({
            format: 'A4',
            printBackground: true,
            ...config?.pdf
        })
    } finally {
        await page.close()
    }
}

export async function teardown({ options, config, logger }) {
    if (!options?.watch) {
        await browser?.close()
        browser = undefined
        logger.debug('Puppeteer browser closed')
        return
    }
    const delay = config?.teardownDelay ?? TEARDOWN_DELAY
    teardownTimer = setTimeout(async () => {
        teardownTimer = undefined
        await browser?.close()
        browser = undefined
        logger.debug('Puppeteer browser closed')
    }, delay)
    logger.debug('Puppeteer browser teardown scheduled in %dms', delay)
}

// v9 factory — descriptor stored in `runtime.postprocessors`. Workers
// keep using the top-level `setup`/`postprocess`/`teardown` + `output`
// exports above for dynamic-import dispatch. ADR-0010.
export function postPdf(options = {}) {
    return {
        name: options.name ?? 'pdf',
        options,
        output,
        setup,
        postprocess,
        teardown,
    }
}
