// The Updates card inside the desktop window: the Desktop app zone in every state the shell has
// (docs/plans/unified-updates.md, Design): download with progress, restart, the question when work is
// live (open terminals included), apt-managed, the copied `.deb` command, a shell apt replaced, a
// download with no valid signature, the switch to the AppImage, the explanation when the app cannot
// update itself. Electron is not in the harness, so a script that runs before the app stands in for
// the preload's `window.claudioDesktop`, answering the way apps/desktop/src/updater.ts, payload.ts
// and switch.ts do; the card, its parsers and its dialogs are the real ones. Nothing is ever applied.

const CARD = '[data-testid=updates-card]';
const DESKTOP = '[data-testid=update-desktop]';
const NEXT = '999.0.0';
// What apps/desktop/src/desktop-manifest.ts builds: long, so it has to wrap
const CACHE = '/home/someone-with-a-long-name/.cache/claudio-updater/pending/Claudio-999.0.0-amd64.deb';
const SHA = 'ab'.repeat(32);
const COMMAND =
  `/usr/bin/sudo /usr/bin/install -D -m 0644 -o root -g root -- '${CACHE}' '/var/cache/claudio/claudio_${NEXT}_amd64.deb'` +
  ` && echo '${SHA}  /var/cache/claudio/claudio_${NEXT}_amd64.deb' | /usr/bin/sha256sum -c -` +
  ` && /usr/bin/sudo /usr/bin/apt install -- '/var/cache/claudio/claudio_${NEXT}_amd64.deb'`;
const NO_SWITCH = { available: false, reason: 'not-deb', debStillInstalled: false };

/**
 * A fake shell whose updater starts at `initial` and whose switch state is `switchState`; what the
 * card asks is recorded on window.__updates
 */
const fakeShell = (initial, switchState = NO_SWITCH) => `(() => {
  const listeners = new Set();
  const updates = { state: ${JSON.stringify(initial)}, calls: [], pageReady: 0 };
  const emit = (state) => {
    updates.state = state;
    for (const listener of listeners) listener(state);
  };
  const pageReady = () => {
    updates.pageReady += 1;
  };
  window.__updates = updates;
  window.claudioDesktop = {
    platform: 'linux',
    version: '0.0.0',
    pageReady,
    updates: {
      state: async () => updates.state,
      onState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      download: async () => {
        updates.calls.push({ download: true });
        emit({ status: 'downloading', version: ${JSON.stringify(NEXT)}, percent: 40 });
        // Long enough for the spec to see the progress bar, then the signature check
        setTimeout(() => emit({ status: 'verifying', version: ${JSON.stringify(NEXT)} }), 1500);
        setTimeout(() => emit({ status: 'ready', version: ${JSON.stringify(NEXT)} }), 2500);
      },
      install: async (options = {}) => {
        updates.calls.push({ install: options });
        const version = updates.state.version ?? ${JSON.stringify(NEXT)};
        if (options.whenIdle) return { status: 'scheduled', version };
        if (options.force) return { status: 'restarting', version };
        return { status: 'busy', version, live: { working: 2, waiting: 0, running: 1, terminals: 1 } };
      },
      payload: async (action) => {
        updates.calls.push({ payload: action });
        return { status: 503, code: null };
      },
      switchState: async () => (${JSON.stringify(switchState)}),
      switchToAppImage: async (options = {}) => {
        updates.calls.push({ switch: options });
        return { status: 'restarting', version: ${JSON.stringify(NEXT)} };
      },
      pageReady,
    },
  };
})();`;

const cardSays = (text) => `return (document.querySelector(${JSON.stringify(CARD)})?.innerText ?? '').includes(${JSON.stringify(text)})`;
const desktopButtons = `return [...document.querySelectorAll(${JSON.stringify(`${DESKTOP} button`)})].map((b) => b.innerText.trim())`;

export default async ({ page, api, check, releases }) => {
  // A new document each time, so the fake shell injected with onNewDocument runs: from the same
  // path, an address that differs only in its #section is a same-document navigation
  const openUpdates = async () => {
    await page.goto('/settings', 0);
    await page.goto('/settings/general#updates', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(DESKTOP)})`, { label: 'the desktop branch of the card' });
  };
  const withShell = async (initial, switchState, body) => {
    const remove = await page.onNewDocument(fakeShell(initial, switchState));
    try {
      await openUpdates();
      await body();
    } finally {
      await remove();
    }
  };

  const { current } = (await api.get('/system/release')).body;
  releases.set(`v${NEXT}`);
  const found = await api.post('/system/release/check');
  check(found.body?.updateAvailable === true, `the server knows of ${NEXT}: ${JSON.stringify(found.body)}`);

  try {
    // ---- An AppImage that can update itself ----
    await withShell({ status: 'available', version: NEXT }, NO_SWITCH, async () => {
      const ready = await page.waitFor(`return window.__updates.pageReady`, { label: 'the page telling the shell it rendered' });
      check(ready === 1, `the web says it rendered once, which ends a trial boot's window check: ${ready}`);
      const steps = await page.eval(`return !!document.querySelector(${JSON.stringify(`${DESKTOP} [data-testid^=update-steps]`)})`);
      check(!steps, 'the AppImage gets its own button, not commands');

      await page.click(`${DESKTOP} button`, `Download desktop app ${NEXT}`);
      const bar = await page.waitFor(
        `const bar = document.querySelector(${JSON.stringify(`${DESKTOP} [role=progressbar]`)}); return bar && { name: bar.getAttribute('aria-label'), now: bar.getAttribute('aria-valuenow') }`,
        { label: 'the download progress bar' },
      );
      check(bar.now === '40', `the progress bar has a value: ${JSON.stringify(bar)}`);
      const violations = await page.axe({ include: CARD });
      check(violations.length === 0, `the card passes axe while downloading: ${JSON.stringify(violations, null, 2)}`);
      await page.waitFor(cardSays('Checking the signature…'), { label: 'the signature check' });

      // Live work: a restart asks first, and "Update when I quit" leaves it for later
      await page.waitFor(cardSays(`Restart to update to ${NEXT}`), { label: 'the restart button' });
      await page.click(`${DESKTOP} button`, `Restart to update to ${NEXT}`);
      const question = await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText ?? ''`, { label: 'the live-work question' });
      check(question.includes('2 chats are working, 1 orchestration is running'), `the question says what a restart would stop: ${question}`);
      check(question.includes('1 terminal is open'), `an open terminal counts as live work: ${question}`);
      await page.click('[role=dialog] button', 'Update when I quit');
      await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the question closing once answered' });

      const calls = await page.eval(`return window.__updates.calls`);
      check(
        JSON.stringify(calls) === JSON.stringify([{ download: true }, { install: {} }, { install: { whenIdle: true } }]),
        `the card asked the shell for a download, a restart and then an install on quit: ${JSON.stringify(calls)}`,
      );
    });

    // ---- "Restart now" goes through even with work live ----
    await withShell({ status: 'ready', version: NEXT }, NO_SWITCH, async () => {
      await page.click(`${DESKTOP} button`, `Restart to update to ${NEXT}`);
      await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the live-work question' });
      await page.click('[role=dialog] button', 'Restart now');
      const calls = await page.waitFor(`return window.__updates.calls.length === 2 && window.__updates.calls`, { label: 'the forced install' });
      check(JSON.stringify(calls[1]) === JSON.stringify({ install: { force: true } }), `Restart now forces the install: ${JSON.stringify(calls)}`);
    });

    // ---- A .deb under apt: the system updates it, and the card offers nothing to press ----
    await withShell({ status: 'apt-managed', latest: NEXT }, { available: false, reason: 'sandbox-restricted', debStillInstalled: false }, async () => {
      await page.waitFor(cardSays('Your system updates the desktop app through apt, with its other updates.'), { label: 'the apt sentence' });
      await page.waitFor(cardSays(`Desktop app ${NEXT} is out; it arrives with the system's next update.`), { label: 'the newer release apt will bring' });
      const buttons = await page.eval(desktopButtons);
      check(!buttons.some((b) => /Download|Restart|Install/.test(b)), `nothing to download or install from the app: ${JSON.stringify(buttons)}`);
      check(!(await page.eval(cardSays('Use the AppImage instead'))), 'no switch where the AppImage cannot sandbox without root');
    });

    // ---- A .deb without apt: the exact command, copyable, wrapping, never cut ----
    await withShell({ status: 'copy-command', version: NEXT, command: COMMAND }, NO_SWITCH, async () => {
      await page.waitFor(cardSays('Install it from a terminal.'), { label: 'the copy-command sentence' });
      const shown = await page.waitFor(
        `const el = [...document.querySelectorAll(${JSON.stringify(`${DESKTOP} [data-testid^=update-steps] code, ${DESKTOP} [data-testid^=update-steps] pre`)})].find((e) => e.textContent.includes('sha256sum'));
         return el && { text: el.textContent, overflows: el.scrollWidth > el.clientWidth + 1, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' }`,
        { label: 'the command' },
      );
      check(shown.text.includes(COMMAND), `the whole command is shown: ${shown.text}`);
      check(!shown.overflows && !shown.ellipsis, `the command wraps instead of overflowing or being cut: ${JSON.stringify(shown)}`);
      const copy = await page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${DESKTOP} button`)})].some((b) => /Copy/i.test(b.getAttribute('aria-label') ?? b.innerText))`);
      check(copy, 'the command has a copy button');
      await page.waitFor(cardSays('After this, apt keeps it up to date.'), { label: 'what happens after' });
    });

    // ---- apt replaced the app underneath: Restart Claudio ----
    await withShell({ status: 'shell-replaced', version: NEXT }, NO_SWITCH, async () => {
      await page.waitFor(cardSays(`The system installed desktop app ${NEXT}. Restart Claudio to use it.`), { label: 'the replaced shell' });
      await page.click(`${DESKTOP} button`, 'Restart Claudio');
      await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the live-work question' });
      await page.click('[role=dialog] button', 'Restart now');
      const calls = await page.waitFor(`return window.__updates.calls.length === 2 && window.__updates.calls`, { label: 'the forced restart' });
      check(JSON.stringify(calls) === JSON.stringify([{ install: {} }, { install: { force: true } }]), `Restart Claudio goes through the shell's restart: ${JSON.stringify(calls)}`);
    });

    // ---- A download with no valid signature is discarded, and can be tried again ----
    await withShell({ status: 'error', code: 'bad-signature', message: 'Claudio-999.0.0-x86_64.AppImage does not match the signed desktop manifest' }, NO_SWITCH, async () => {
      await page.waitFor(cardSays('The download has no valid signature and was discarded.'), { label: 'the bad signature, by its code' });
      check(!(await page.eval(cardSays('does not match the signed desktop manifest'))), "the shell's English message is not shown");
      const buttons = await page.eval(desktopButtons);
      check(buttons.includes('Try again'), `a way out: ${JSON.stringify(buttons)}`);
    });

    // ---- The switch to the AppImage, where it can sandbox ----
    await withShell({ status: 'apt-managed', latest: null }, { available: true, reason: null, debStillInstalled: false }, async () => {
      await page.click(`${DESKTOP} a, ${DESKTOP} button`, 'Use the AppImage instead');
      const dialog = await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText ?? ''`, { label: 'the switch dialog' });
      check(dialog.includes('Switch to the AppImage?'), `the dialog asks: ${dialog}`);
      check(dialog.includes('The .deb stays installed until you remove it.'), `the dialog says what stays: ${dialog}`);
      await page.click('[role=dialog] button', 'Switch and restart');
      const calls = await page.waitFor(`return window.__updates.calls.length === 1 && window.__updates.calls`, { label: 'the switch' });
      check(JSON.stringify(calls) === JSON.stringify([{ switch: { force: false } }]), `the card asked the shell to switch: ${JSON.stringify(calls)}`);
    });

    // ---- On the AppImage, while the .deb is still installed ----
    await withShell({ status: 'idle' }, { available: false, reason: 'not-deb', debStillInstalled: true }, async () => {
      await page.waitFor(cardSays('The .deb is still installed. Remove it from a terminal:'), { label: 'the leftover .deb' });
      await page.waitFor(cardSays('/usr/bin/sudo /usr/bin/apt remove claudio'), { label: 'the command that removes it' });
    });

    // ---- An app that cannot update itself says why and links the release ----
    const message = 'This copy of Claudio was not installed from an AppImage or a .deb, so it cannot update itself.';
    await withShell({ status: 'unsupported', reason: 'unknown-package', message }, NO_SWITCH, async () => {
      await page.waitFor(cardSays(message), { label: "the shell's own explanation" });
      const links = await page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${DESKTOP} a`)})].map((a) => a.href)`);
      check(links.includes(releases.url), `the release page is linked: ${links.join(', ')}`);
      const download = await page.eval(`return !!document.querySelector(${JSON.stringify(`${DESKTOP} button`)})`);
      check(!download, 'no Download button where the app cannot install it');
    });
  } finally {
    // Back to the version in use, so the specs after this one see no dot
    releases.set(`v${current}`);
    await api.post('/system/release/check');
  }
};
