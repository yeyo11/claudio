// Moving cards on the Tasks board (C9 of docs/plans/regression-fixes-2026-10-29.md): a downward drag,
// a drop at the last place, into an empty column and across columns, each kept across a reload; on
// the All projects board a card lands inside its own project's group, whatever card the pointer was
// over; a refused move puts the card back once and says why; a stuck keyboard grab does not stop a
// drag; and a finger moves a card through its "⋯", on a touch screen and on a phone.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The keys drawn in a column, top to bottom */
const keysIn = (status) => `[...document.querySelectorAll('.workitem-col[data-status="${status}"] [data-item-id] .workitem-key')].map((k) => k.textContent)`;

/**
 * A pointer drag of a card, with the browser's own events: over `target` (a card's id, to drop just
 * below its middle, or null for the end of the column) in the column `status`. Answers whether the
 * drop line was drawn, and the index among the column's cards it was drawn before.
 */
const drag = (id, status, target) => `
  const card = document.querySelector('[data-item-id="${id}"]');
  const body = document.querySelector('.workitem-col[data-status="${status}"] .workitem-col-body');
  const over = ${target ? `document.querySelector('[data-item-id="${target}"]').getBoundingClientRect()` : 'null'};
  const box = body.getBoundingClientRect();
  const dt = new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 60));
  const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 10, clientY: over ? over.top + over.height / 2 + 1 : box.bottom - 2 };
  body.dispatchEvent(new DragEvent('dragover', at));
  await new Promise((r) => setTimeout(r, 60));
  const line = body.querySelector('.workitem-drop');
  const before = line ? [...body.children].slice([...body.children].indexOf(line) + 1).find((el) => el.matches('[data-item-id]'))?.dataset.itemId ?? null : undefined;
  body.dispatchEvent(new DragEvent('drop', at));
  card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return { line: !!line, before };`;

export default async ({ page, api, check, dirs }) => {
  const made = [];
  try {
    const project = async (name) => {
      const dir = join(dirs.workspaceDir, name);
      mkdirSync(dir, { recursive: true });
      const imported = await api.post('/projects/import', { path: dir, name, template: 'software' });
      check(imported.status === 201, `${name} was imported (${imported.status})`);
      made.push(imported.body.id);
      return imported.body;
    };
    const add = async (projectId, title, status) => {
      const created = await api.post(`/projects/${projectId}/work-items`, { title });
      check(created.status === 201, `"${title}" was created (${created.status})`);
      if (status) await api.post(`/work-items/${created.body.id}/move`, { status });
      return created.body;
    };
    const serverKeys = async (projectId, status) =>
      (await api.get(`/projects/${projectId}/work-items/board`)).body.columns.find((c) => c.status === status).items.map((i) => i.key);

    const one = await project('e2e-moves');
    const a = await add(one.id, 'Move A', 'todo');
    const b = await add(one.id, 'Move B', 'todo');
    const c = await add(one.id, 'Move C', 'todo');
    const d = await add(one.id, 'Move D', 'in_progress');

    await page.viewport(1440, 900);
    await page.goto(`/tasks?project=${one.id}`, 1200);
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify([a.key, b.key, c.key]))}`, { label: 'the board in rank order' });

    // ---- a downward drag: A dropped below B's middle lands after B ----
    const down = await page.eval(drag(a.id, 'todo', b.id));
    check(down.line && down.before === c.id, `the drop line is drawn between B and C (${JSON.stringify(down)})`);
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify([b.key, a.key, c.key]))}`, { label: 'A after B' });
    await page.waitFor(`return (await fetch('/api/projects/${one.id}/work-items/board').then((r) => r.json())).columns[1].items[1].key === ${JSON.stringify(a.key)}`, { label: 'the downward move reached the API' });

    // ---- the last place of the column ----
    const last = await page.eval(drag(b.id, 'todo', null));
    check(last.line && last.before === null, `the drop line is drawn at the end of the column (${JSON.stringify(last)})`);
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify([a.key, c.key, b.key]))}`, { label: 'B last' });

    // ---- into an empty column, and across columns between two cards ----
    await page.eval(drag(c.id, 'in_review', null));
    await page.waitFor(`return JSON.stringify(${keysIn('in_review')}) === ${JSON.stringify(JSON.stringify([c.key]))}`, { label: 'C alone in In review' });
    await page.eval(drag(b.id, 'in_progress', d.id));
    await page.waitFor(`return JSON.stringify(${keysIn('in_progress')}) === ${JSON.stringify(JSON.stringify([d.key, b.key]))}`, { label: 'B after D in In progress' });
    await page.goto(`/tasks?project=${one.id}`, 1200);
    await page.waitFor(
      `return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify([a.key]))} && JSON.stringify(${keysIn('in_progress')}) === ${JSON.stringify(JSON.stringify([d.key, b.key]))} && JSON.stringify(${keysIn('in_review')}) === ${JSON.stringify(JSON.stringify([c.key]))}`,
      { label: 'every move survives a reload' },
    );
    check(JSON.stringify(await serverKeys(one.id, 'in_progress')) === JSON.stringify([d.key, b.key]), 'and the server holds the same order');

    // ---- a keyboard grab left behind does not stop a drag, and leaving the card puts it back ----
    await page.focus(`[data-item-id="${a.id}"]`);
    await page.press(' ');
    check((await page.text('.workitem-announce')).includes('picked up'), 'the card is picked up');
    await page.focus('.workitem-search input');
    await page.waitFor(`return !document.querySelector('.workitem-card.is-grabbed')`, { label: 'leaving the card puts it back' });
    check((await page.eval(`return document.querySelector('[data-item-id="${c.id}"]').draggable`)) === true, 'every card can still be dragged');

    // ---- a refused move goes back once, and says why ----
    await page.eval(`
      const f = window.fetch;
      window.__refuseMoves = true;
      window.fetch = async (input, init) => {
        const u = String(input?.url ?? input);
        if (window.__refuseMoves && (init?.method ?? input?.method) === 'POST' && u.includes('/move')) {
          await new Promise((r) => setTimeout(r, 300));
          return new Response(JSON.stringify({ error: 'refused by the e2e spec' }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return f(input, init);
      };
      return true`);
    await page.eval(drag(a.id, 'in_review', c.id));
    await page.waitFor(`return JSON.stringify(${keysIn('in_review')}) === ${JSON.stringify(JSON.stringify([c.key, a.key]))}`, { label: 'the card is drawn where it was dropped at once' });
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify([a.key]))} && JSON.stringify(${keysIn('in_review')}) === ${JSON.stringify(JSON.stringify([c.key]))}`, {
      label: 'and put back when the move is refused',
    });
    await page.waitFor(`return [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(`${a.key} could not move to In review`)}))`, { label: 'a toast says which card and where' });
    check((await page.eval(`return document.querySelector('.workitem-col[data-status="todo"] .workitem-col-count [aria-hidden]')?.textContent`)) === '1', 'the counts are back too');
    await page.eval(`window.__refuseMoves = false; return true`);
    check((await api.get(`/work-items/${a.id}`)).body.status === 'todo', 'the server never moved it');

    // ---- All projects: a card lands inside its own project's group ----
    const two = await project('e2e-moves-two');
    const e = await add(two.id, 'Move E', 'todo');
    const f = await add(two.id, 'Move F', 'todo');
    await page.goto('/tasks?project=all', 1500);
    await page.waitFor(`return ${keysIn('todo')}.length === 3`, { label: 'the All projects board' });
    const groups = await page.eval(`return ${keysIn('todo')}`);
    // Whichever project sorts first, A is alone in its group and E, F make the other
    const aFirst = groups[0] === a.key;
    check(JSON.stringify(groups) === JSON.stringify(aFirst ? [a.key, e.key, f.key] : [e.key, f.key, a.key]), `each project's cards are one group (${groups})`);
    // E dragged to the far edge, past A: it stays in its group, at that group's edge
    const far = await page.eval(drag(e.id, 'todo', aFirst ? null : a.id));
    check(far.line, 'the drop line is drawn');
    check(far.before === (aFirst ? null : a.id), `inside E's group, never among A's cards (${JSON.stringify(far)})`);
    const expected = aFirst ? [a.key, f.key, e.key] : [f.key, e.key, a.key];
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify(expected))}`, { label: 'E at the end of its own group' });
    await page.waitFor(`return (await fetch('/api/projects/${two.id}/work-items/board').then((r) => r.json())).columns[1].items.map((i) => i.key).join() === ${JSON.stringify([f.key, e.key].join())}`, {
      label: 'the server took the move, no 400',
    });
    // A dropped at the very top, above the other project's cards: the top of its own group
    const top = await page.eval(`
      const card = document.querySelector('[data-item-id="${a.id}"]');
      const body = document.querySelector('.workitem-col[data-status="todo"] .workitem-col-body');
      const first = body.querySelector('[data-item-id]').getBoundingClientRect();
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 60));
      const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: first.left + 10, clientY: first.top + 1 };
      body.dispatchEvent(new DragEvent('dragover', at));
      body.dispatchEvent(new DragEvent('drop', at));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return true`);
    check(top, 'a drag to the top of a mixed column');
    check((await api.get(`/work-items/${a.id}`)).body.status === 'todo', 'and A stays in To do, alone in its project');
    await page.goto('/tasks?project=all', 1500);
    await page.waitFor(`return JSON.stringify(${keysIn('todo')}) === ${JSON.stringify(JSON.stringify(expected))}`, { label: 'nothing jumps after a reload' });

    // ---- a finger on a wide screen: the card's "⋯" moves it ----
    await page.emulateTouch(true);
    await page.goto(`/tasks?project=${one.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('[data-item-id="${a.id}"] .workitem-card-more button')`, { label: 'a coarse pointer gets the card menu' });
    // Radix opens a menu on pointerdown, which a synthetic click is not: the keyboard's way
    await page.focus(`[data-item-id="${a.id}"] .workitem-card-more button`);
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the move menu' });
    check((await page.eval(`return location.search.includes('item=')`)) === false, 'opening the menu does not open the item');
    await page.click('[role=menu] [role=menuitem]', 'Move to In progress', 900);
    await page.waitFor(`return (await fetch('/api/work-items/${a.id}').then((r) => r.json())).status === 'in_progress'`, { label: 'the menu moves the card' });
    check(JSON.stringify(await serverKeys(one.id, 'in_progress')) === JSON.stringify([a.key, d.key, b.key]), 'into the next column at its top');
    await page.emulateTouch(false);

    // ---- a phone: the row's sheet, a step down inside the column ----
    await page.viewport(390, 844);
    await page.goto(`/tasks?project=${one.id}`, 1400);
    await page.waitFor(`return document.querySelectorAll('.workitem-msection').length === 5`, { label: 'the phone board' });
    await page.click(`.workitem-mrow[data-item-id="${a.id}"] .workitem-mrow-more`, undefined, 600);
    await page.click('.sheet-actions .btn', 'Move down', 900);
    await page.waitFor(`return (await fetch('/api/projects/${one.id}/work-items/board').then((r) => r.json())).columns[2].items.map((i) => i.key).join() === ${JSON.stringify([d.key, a.key, b.key].join())}`, {
      label: 'the phone steps a card down its column',
    });
  } finally {
    await page.emulateTouch(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio:project'); return true`).catch(() => {});
    // Later specs count the projects
    for (const id of made) await api.del(`/projects/${id}`).catch(() => {});
  }
};
