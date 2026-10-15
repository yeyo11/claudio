// The message box: an editor that sends plain text (Shift+Enter breaks the line, Enter sends), keeps
// a draft across a reload, brings back what was sent with the arrow keys, and has a "+" menu whose
// switches turn the live chat's MCP servers on and off (the fake CLI's `mcp_status`/`mcp_toggle`).
export const fakeCli = true;

const BOX = 'main .composer [data-composer-input]';
/** The box's text as it is sent: its paragraphs, a line each */
const text = `(e=>e&&[...e.querySelectorAll('p')].map(p=>p.textContent).join('\\n'))(document.querySelector(${JSON.stringify(BOX)}))`;
const textOf = `return ${text}`;
const SHIFT = 8;

export default async ({ page, api, dirs, check }) => {
  const created = await api.post('/chats', { prompt: 'hello', cwd: dirs.workspaceDir });
  check(created.status === 201, `the chat was created (${created.status})`);
  const id = created.body.id;
  const waitForReply = (text) =>
    page.waitFor(`return document.querySelector('.transcript')?.innerText.includes(${JSON.stringify(text)})`, { label: `the reply "${text}"` });
  try {
    await page.goto(`/chats/${id}`, 1200);
    await waitForReply('Heard: hello');
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BOX)})`, { label: 'the message box' });

    // Shift+Enter breaks the line; what the box holds is the text, a line per paragraph
    await page.focus(BOX);
    await page.type('line one');
    await page.key('Enter', SHIFT);
    await page.type('line two');
    check((await page.eval(textOf)) === 'line one\nline two', `Shift+Enter breaks the line (${JSON.stringify(await page.eval(textOf))})`);

    // A reload keeps what was typed and not sent
    await page.sleep(600);
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BOX)})`, { label: 'the box after a reload' });
    check((await page.eval(textOf)) === 'line one\nline two', `the draft survives a reload (${JSON.stringify(await page.eval(textOf))})`);

    // Enter sends it, and the box empties
    await page.focus(BOX);
    await page.key('Enter');
    await waitForReply('Heard: line one');
    await page.waitFor(`return ${text} === ''`, { label: 'the box to empty' });

    // ArrowUp brings back what was sent, newest first; ArrowDown walks back to an empty box
    await page.focus(BOX);
    await page.key('ArrowUp');
    check((await page.eval(textOf)) === 'line one\nline two', `ArrowUp recalls the last message (${JSON.stringify(await page.eval(textOf))})`);
    await page.key('ArrowUp');
    check((await page.eval(textOf)) === 'hello', `ArrowUp again recalls the one before (${JSON.stringify(await page.eval(textOf))})`);
    await page.key('ArrowDown');
    await page.key('ArrowDown');
    check((await page.eval(textOf)) === '', 'ArrowDown walks back to an empty box');

    // The "+" menu lists the live process's servers, the connector by its own name
    await page.click('main .composer-plus');
    await page.waitFor(`return document.querySelectorAll('.composer-server').length === 2`, { label: 'the two servers in the menu' });
    const rows = await page.eval(`return [...document.querySelectorAll('.composer-server')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim().toLowerCase())`);
    check(rows[0]?.startsWith('docs') && rows[0].includes('connected') && rows[0].includes('2 tools'), `the local server, connected with its tools (${rows[0]})`);
    check(rows[1]?.startsWith('calendar') && rows[1].includes('needs-auth') && rows[1].includes('connector'), `the connector, waiting for its authorisation (${rows[1]})`);
    check(await page.eval(`return !!document.querySelector('.composer-server a[href="/connectors"]')`), 'a connector waiting for authorisation links to how to give it');
    await page.shot('composer-menu');

    // Its switch turns the server off in the running process
    await page.click('.composer-server button[role=switch]');
    await page.waitFor(`return document.querySelector('.composer-server')?.classList.contains('is-off')`, { label: 'the server switched off' });
    const after = await api.get(`/chats/${id}/mcp`);
    check(after.body.live === true && after.body.servers[0]?.status === 'disabled', `the process reports it disabled (${JSON.stringify(after.body.servers[0])})`);
  } finally {
    await api.post(`/chats/${id}/stop`);
    for (let i = 0; i < 40; i++) {
      if ((await api.del(`/chats/${id}`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};
