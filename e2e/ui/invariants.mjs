// The UI invariants a machine can measure on a rendered page (docs/plans/claudio-designer.md §2,
// .claude/skills/claudio-ui/references/invariants.md). Each one returns the offending elements, so a
// failure says where to look. They take a page of e2e/driver.mjs and are used by two callers: the
// e2e spec ui-invariants.spec.mjs (over the main routes, with long content seeded) and
// scripts/ui-check.mjs (one route of a running instance, for the hook and the ui-reviewer agent).
//
// Not here because a spec already holds them: axe (I8, a11y-*.spec.mjs), keyboard reach and Escape
// (I12, a11y-shell.spec.mjs), motion levels (I13, motion.spec.mjs) and token contrast (I14,
// a11y-shared.mjs). ui-check runs axe itself, since it has no spec around it.

/** A short name for an element in a report: tag, first classes, and the start of its text */
const DESCRIBE = `const describe=(el)=>{const c=[...el.classList].slice(0,3).join('.');const t=(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);return el.tagName.toLowerCase()+(c?'.'+c:'')+(t?' "'+t+'"':'')};` +
  `const shown=(el)=>{if(!el.getClientRects().length)return false;const s=getComputedStyle(el);if(s.visibility==='hidden'||s.display==='none')return false;` +
  // Off screen until focused (the skip link) or scrolled out sideways: not a target anyone sees
  `const r=el.getBoundingClientRect();return r.right>0&&r.bottom>0&&r.left<innerWidth&&r.width>0};`;

/** I1: the page itself never scrolls sideways */
export async function horizontalScroll(page) {
  const extra = await page.eval(`return document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  return extra > 0 ? [`the page scrolls sideways by ${extra}px`] : [];
}

/** I2: an element whose content overflows it with overflow-x visible, and no ancestor that clips or scrolls it */
export async function overflowLeaks(page) {
  return page.eval(
    DESCRIBE +
      `const out=[];for(const el of document.querySelectorAll('body *')){if(!shown(el))continue;const s=getComputedStyle(el);` +
      `if(s.overflowX!=='visible'||el.scrollWidth<=el.clientWidth+1||el.clientWidth===0)continue;` +
      `if(['svg','path','g','canvas'].includes(el.tagName.toLowerCase())||el.closest('svg,.xterm,.cm-editor'))continue;` +
      `let a=el.parentElement,managed=false;while(a&&a!==document.body){const ps=getComputedStyle(a);if(ps.overflowX!=='visible'){managed=true;break}a=a.parentElement}` +
      `if(!managed)out.push(describe(el)+' ('+el.clientWidth+'→'+el.scrollWidth+'px)')}return out.slice(0,20)`,
  );
}

/** I3: text cut by an ellipsis or a line clamp that does not carry its full text anywhere */
export async function truncatedWithoutFullText(page) {
  return page.eval(
    DESCRIBE +
      `return [...document.querySelectorAll('body *')].filter((el)=>{if(!shown(el))return false;const s=getComputedStyle(el);` +
      `const clamped=s.textOverflow==='ellipsis'||(s.webkitLineClamp&&s.webkitLineClamp!=='none');if(!clamped)return false;` +
      `const cut=el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1;if(!cut)return false;` +
      `const host=el.closest('[title],[aria-describedby],[data-tooltip],[data-state][aria-label]');` +
      `return !(host||el.getAttribute('aria-label'))}).map(describe).slice(0,20)`,
  );
}

/** I4, first half: from now on, every layout shift counts, the ones right after an input included */
export async function startLayoutShift(page) {
  await page.eval(
    `window.__shift=0;window.__shifts=[];window.__shiftObs?.disconnect();` +
      `window.__shiftObs=new PerformanceObserver((list)=>{for(const e of list.getEntries()){window.__shift+=e.value;` +
      `window.__shifts.push((e.sources||[]).map((s)=>s.node?(s.node.className&&typeof s.node.className==='string'?s.node.tagName.toLowerCase()+'.'+s.node.className.split(' ')[0]:s.node.nodeName):'?').join(', '))}});` +
      `window.__shiftObs.observe({type:'layout-shift',buffered:false});return true`,
  );
}

/** I4, second half: the shift since `startLayoutShift`, as problems when it is 0.001 or more */
export async function readLayoutShift(page, label) {
  const { total, sources } = await page.eval(`window.__shiftObs?.disconnect();return {total:window.__shift??0,sources:[...new Set(window.__shifts??[])].slice(0,6)}`);
  return total >= 0.001 ? [`${label}: layout shift ${total.toFixed(4)} (moved: ${sources.join(' | ') || 'unknown'})`] : [];
}

/** I5: a button with states (`data-states="idle|loading|done"`) keeps its width in every state */
export async function unstableButtons(page) {
  return page.eval(
    DESCRIBE +
      `const out=[];for(const b of document.querySelectorAll('button[data-states]')){if(!shown(b))continue;const w0=b.getBoundingClientRect().width;const was=b.dataset.state;` +
      `for(const s of (b.dataset.states||'').split('|')){b.dataset.state=s;await new Promise((r)=>requestAnimationFrame(()=>r()));const w1=b.getBoundingClientRect().width;` +
      `if(Math.abs(w1-w0)>0.5)out.push(describe(b)+' → '+s+': '+w0.toFixed(1)+'→'+w1.toFixed(1)+'px')}if(was===undefined)delete b.dataset.state;else b.dataset.state=was}return out`,
  );
}

/** I6: a vertical scroller reserves its scrollbar's room, so content does not jump when it appears */
export async function scrollbarGutter(page) {
  return page.eval(
    DESCRIBE +
      `return [...document.querySelectorAll('body *')].filter((el)=>{if(!shown(el))return false;const s=getComputedStyle(el);` +
      `return /auto|scroll/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+1&&el.clientHeight>120&&!/stable/.test(s.scrollbarGutter)&&!el.closest('.xterm,.cm-editor,[role=listbox],[role=menu]')})` +
      `.map(describe).slice(0,20)`,
  );
}

/** I7: a number that changes while it is read is tabular, so its neighbours do not move */
export async function proportionalNumbers(page) {
  return page.eval(
    DESCRIBE +
      `return [...document.querySelectorAll('[data-live-number], .tnum')].filter((el)=>shown(el)&&!/tabular-nums/.test(getComputedStyle(el).fontVariantNumeric)).map(describe).slice(0,20)`,
  );
}

/** I9: targets of at least `min` px (44 on a phone, 24 above): the box a finger or a pointer gets */
export async function smallTargets(page, min) {
  return page.eval(
    DESCRIBE +
      `const sel='button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option]';` +
      `const out=[];for(const el of document.querySelectorAll(sel)){if(!shown(el)||el.closest('[aria-hidden=true],[inert]'))continue;` +
      `const s=getComputedStyle(el);if(el.tagName==='A'&&s.display==='inline'&&el.closest('p,li,td,.md,.markdown'))continue;` +
      `const r=el.getBoundingClientRect();if(r.width<${min}-0.5||r.height<${min}-0.5)out.push(describe(el)+' '+Math.round(r.width)+'×'+Math.round(r.height))}return out.slice(0,25)`,
  );
}

/** I10: a field below 16 px makes iOS zoom into it on focus */
export async function smallInputs(page) {
  return page.eval(
    DESCRIBE +
      `return [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable=true]')]` +
      `.filter((el)=>shown(el)&&parseFloat(getComputedStyle(el).fontSize)<16).map((el)=>describe(el)+' '+getComputedStyle(el).fontSize).slice(0,20)`,
  );
}

/**
 * Closes the tooltips left open, one Escape at a time while one is up: a tooltip is the top layer, so
 * the Escape is its own and never reaches a dialog or a sheet the page meant to have open. Waits until
 * none is left (or a second has passed, so a tooltip that will not close cannot hang the pass).
 */
const CLOSE_TOOLTIPS =
  `const closeTooltips=async()=>{const open=()=>document.querySelector('.tooltip,[data-radix-popper-content-wrapper] [role=tooltip]');` +
  `const frame=()=>new Promise((r)=>requestAnimationFrame(()=>r()));` +
  `for(let i=0;i<60&&open();i++){if(i%6===0)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await frame()}};`;

/**
 * I11: everything that takes focus shows it, with an outline or a ring. A field drawn inside a
 * bordered wrapper (search, number input) has its ring on the wrapper's :focus-within, so the
 * nearest ancestors count; `closest()` would return the focused element itself, which also matches
 * :focus-within, and miss every such ring.
 */
export async function invisibleFocus(page) {
  return page.eval(
    DESCRIBE +
      CLOSE_TOOLTIPS +
      `const items=[...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el)=>shown(el)&&!el.disabled&&!el.closest('[inert],[aria-hidden=true]'));` +
      `const look=(n)=>{const s=getComputedStyle(n);return s.boxShadow+'|'+(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0?s.outlineStyle+s.outlineWidth+s.outlineColor:'none')};` +
      `const out=[];const before=document.activeElement;for(const el of items.slice(0,120)){const up=[];for(let w=el.parentElement,i=0;w&&i<3;w=w.parentElement,i++)up.push(w);` +
      // Transitions off while measuring: a ring fading in or out reads as neither there nor gone
      `const held=[el,...up].map((n)=>[n,n.style.transition]);for(const [n] of held)n.style.transition='none';` +
      `document.activeElement?.blur?.();const rest=up.map(look);el.focus({preventScroll:true});` +
      `const s=getComputedStyle(el);const ring=(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none';` +
      // A wrapper's ring counts only when focus is what drew it, not a card's resting shadow
      `const wrapped=up.some((w,i)=>look(w)!==rest[i]);const took=document.activeElement===el;for(const [n,t] of held)n.style.transition=t;` +
      `if(took&&!ring&&!wrapped)out.push(describe(el))}` +
      // Leave the page as it was found: every trigger the walk focused may have left its tooltip open,
      // and axe (region) and the screenshots that come after would read those layers as the page
      `document.activeElement?.blur?.();if(before&&before!==document.body)before.focus?.({preventScroll:true});` +
      `await closeTooltips();return out.slice(0,20)`,
  );
}

/**
 * Every invariant that reads a page as it stands, at one width. `fast` keeps the ones the edit hook
 * runs on every change (I1, I2, I9 on a phone, I10); the rest are for the review and the e2e run.
 */
export async function pageInvariants(page, { width, fast = false }) {
  // Keyboard focus is what draws a :focus-visible ring; a headless tab is never the focused one
  await page.emulateFocus?.(true);
  const found = [];
  const add = (code, list) => {
    for (const item of list) found.push(`${code} ${item}`);
  };
  add('I1', await horizontalScroll(page));
  add('I2', await overflowLeaks(page));
  if (width < 768) {
    add('I9', await smallTargets(page, 44));
    add('I10', await smallInputs(page));
  }
  if (fast) return found;
  if (width >= 768) add('I9', await smallTargets(page, 24));
  add('I3', await truncatedWithoutFullText(page));
  add('I5', await unstableButtons(page));
  if (width >= 768) add('I6', await scrollbarGutter(page));
  add('I7', await proportionalNumbers(page));
  add('I11', await invisibleFocus(page));
  return found;
}

/**
 * Waits for the page to be there (a <main> with content and nothing busy in it, as the a11y specs
 * wait) and then for fonts and two frames, so a measurement never passes on a blank or half-laid page.
 */
export async function settle(page) {
  await page.waitFor(`const m=document.querySelector('main');return m&&m.innerText.trim().length>20&&!m.querySelector('[aria-busy=true]')`, { label: 'the page content', timeout: 20000 });
  await page.eval(`await document.fonts?.ready;await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))));return true`);
}

/**
 * Runs in the page (it is serialised by `overlayFit`, so it takes and closes over nothing): what an
 * open dialog, drawer or sheet must hold at the width it is seen at. Every finding names the panel.
 */
function overlayFitInPage({ touch }) {
  const out = [];
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const describe = (el) => {
    const c = [...el.classList].slice(0, 2).join('.');
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return el.tagName.toLowerCase() + (c ? '.' + c : '') + (t ? ' "' + t + '"' : '');
  };
  const vw = document.documentElement.clientWidth;
  // What the on-screen keyboard leaves (lib/viewport.ts measures it where the browser does not resize the page)
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset')) || 0;
  const vh = window.innerHeight - kb;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;padding:var(--ov-top) var(--ov-right) var(--ov-bottom) var(--ov-left);margin-top:var(--chrome-top)';
  document.body.appendChild(probe);
  const ps = getComputedStyle(probe);
  const ov = { top: parseFloat(ps.paddingTop), right: parseFloat(ps.paddingRight), bottom: parseFloat(ps.paddingBottom), left: parseFloat(ps.paddingLeft) };
  const chromeTop = parseFloat(ps.marginTop) || 0;
  // The keyboard covers the home indicator, so the panel keeps only the gutter below it
  if (kb) ov.bottom = Math.min(ov.bottom, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--overlay-gutter')) || 12);
  probe.remove();
  // Only the one on top is looked at: what stacks under it is covered by design
  const panels = [...document.querySelectorAll('[role=dialog]')].filter(shown).slice(-1);
  for (const panel of panels) {
    const name = describe(panel);
    const add = (msg) => out.push(`${name}: ${msg}`);
    const r = panel.getBoundingClientRect();
    const overlay = panel.closest('.overlay');
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) add(`outside the viewport (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} of ${vw}×${vh})`);
    if (overlay && (r.top < ov.top - 0.5 || r.bottom > vh - ov.bottom + 0.5 || r.left < ov.left - 0.5 || r.right > vw - ov.right + 0.5)) add(`leaves the overlay gutter (top ${Math.round(r.top)}/${Math.round(ov.top)}, bottom ${Math.round(vh - r.bottom)}/${Math.round(ov.bottom)})`);
    const head = panel.querySelector('.dialog-head, .sheet-head, .newtask-screen-head, .viewer-bar');
    const close = panel.querySelector('.dialog-head .icon-btn, .sheet-head .icon-btn, .newtask-screen-head .newtask-cancel, .viewer-bar button.icon-btn');
    if (!close) {
      // A popover closes with Escape or a tap outside; a dialog, a drawer, a sheet and a screen have their button
      if (!panel.matches('.popover')) add('has no close button in its head');
    }
    else {
      const c = close.getBoundingClientRect();
      if (c.right > vw + 0.5 || c.left < -0.5 || c.top < -0.5 || c.bottom > vh + 0.5) add('the close button is off screen');
      if (c.right > r.right + 0.5 || c.left < r.left - 0.5) add('the close button is outside its panel');
      if (c.top < chromeTop - 0.5) add(`the close button sits in the window controls' band (top ${Math.round(c.top)} < ${Math.round(chromeTop)})`);
      const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
      if (!at || !close.contains(at)) add(`the close button is covered by ${at ? describe(at) : 'nothing'}`);
      if (touch && (c.width < 43.5 || c.height < 43.5)) add(`the close button is ${Math.round(c.width)}×${Math.round(c.height)}`);
      const title = head?.querySelector('h2, .sheet-title, .viewer-name');
      if (title) {
        const t = title.getBoundingClientRect();
        if (t.right > c.left + 0.5 && t.left < c.right - 0.5 && t.top < c.bottom - 0.5 && t.bottom > c.top + 0.5) add('the title runs under the close button');
      }
    }
    if (head) {
      for (const el of head.querySelectorAll('h2, .sheet-title, .sheet-description')) {
        const s = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && s.overflowX === 'visible') add(`the title overflows its box (${el.clientWidth}→${el.scrollWidth}px)`);
      }
    }
    // The three bands of the panel stay inside it, and the body is what scrolls
    for (const part of panel.querySelectorAll(':scope > .dialog-head, :scope > .dialog-body, :scope > .dialog-foot, :scope > .sheet-head, :scope > .sheet-body, :scope > .sheet-foot, :scope > .sheet-grab, :scope > .newtask-screen-head, :scope > .newtask-screen-body, :scope > .newtask-screen-foot')) {
      const p = part.getBoundingClientRect();
      if (p.height > 0 && (p.bottom > r.bottom + 1 || p.top < r.top - 1)) add(`${describe(part)} spills out of the panel`);
    }
    const foot = panel.querySelector('.dialog-foot, .sheet-foot, .newtask-screen-foot');
    if (foot) {
      const f = foot.getBoundingClientRect();
      if (foot.scrollWidth > foot.clientWidth + 1) add(`the footer overflows sideways (${foot.clientWidth}→${foot.scrollWidth}px)`);
      for (const b of foot.querySelectorAll('button, a[href], [role=button]')) {
        if (!shown(b)) continue;
        const br = b.getBoundingClientRect();
        if (br.right > Math.min(f.right, vw) + 0.5 || br.left < Math.max(f.left, 0) - 0.5 || br.bottom > vh + 0.5) add(`footer button ${describe(b)} is clipped`);
        const at = document.elementFromPoint(Math.min(Math.max(br.left + br.width / 2, 0), vw - 1), Math.min(br.top + br.height / 2, vh - 1));
        if (at && !b.contains(at)) add(`footer button ${describe(b)} is covered by ${describe(at)}`);
      }
    }
    const body = panel.querySelector('.dialog-body, .sheet-body, .newtask-screen-body');
    if (body && body.scrollWidth > body.clientWidth + 1) {
      // overflow-y: auto makes overflow-x auto as well: a body that scrolls sideways is the finding
      add(`the body overflows sideways (${body.clientWidth}→${body.scrollWidth}px)`);
    }
    // Anything that sticks out of the panel's sides with no scroller or clip between
    const scrollers = [];
    const stuck = [];
    for (const el of panel.querySelectorAll('*')) {
      if (!shown(el) || el.closest('svg')) continue;
      const s = getComputedStyle(el);
      if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && !el.matches('pre, code, textarea')) scrollers.push(el);
      // Text the ellipsis cuts carries its whole (I3): a title is the one a phone cannot widen
      if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && !el.closest('[title],[aria-describedby],[data-tooltip]') && !el.getAttribute('aria-label')) add(`${describe(el)} is cut by an ellipsis and carries no full text`);
      const er = el.getBoundingClientRect();
      if (er.width === 0 || er.height === 0 || (er.width <= 1 && er.height <= 1)) continue;
      // Clipped by an ancestor that scrolls or hides: the sides it sticks out of are its own business
      let clip = null;
      for (let a = el.parentElement; a && a !== panel.parentElement; a = a.parentElement) {
        const as = getComputedStyle(a);
        if (as.overflowX !== 'visible' || as.overflowY !== 'visible') {
          if (!clip) clip = a;
          const ar = a.getBoundingClientRect();
          // A positioned control that the nearest clipping ancestor cuts: the scroll-jump class of bug
          if (/absolute|fixed|sticky/.test(s.position) && a === clip && (er.bottom > ar.bottom + 1.5 || er.top < ar.top - 1.5 || er.right > ar.right + 1.5 || er.left < ar.left - 1.5) && (!/auto|scroll/.test(as.overflowY + as.overflowX) || s.position === 'sticky')) {
            stuck.push(`${describe(el)} is cut by ${describe(a)}`);
          }
        }
      }
      if (!clip && (er.right > r.right + 1 || er.left < r.left - 1)) add(`${describe(el)} sticks out of the panel by ${Math.round(Math.max(er.right - r.right, r.left - er.left))}px`);
    }
    for (const msg of new Set(stuck)) add(msg);
    const nested = scrollers.filter((a) => scrollers.some((b) => b !== a && b.contains(a)));
    if (nested.length) add(`nested scrollers: ${nested.map(describe).slice(0, 3).join(', ')}`);
    if (touch) {
      const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option]';
      for (const el of panel.querySelectorAll(sel)) {
        if (!shown(el) || el.closest('[aria-hidden=true],[inert]')) continue;
        const s = getComputedStyle(el);
        if (el.tagName === 'A' && s.display === 'inline' && el.closest('p,li,td,.md,.markdown')) continue;
        const er = el.getBoundingClientRect();
        if (er.width < 43.5 || er.height < 43.5) add(`target ${describe(el)} is ${Math.round(er.width)}×${Math.round(er.height)}`);
      }
      for (const el of panel.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable=true]')) {
        if (shown(el) && parseFloat(getComputedStyle(el).fontSize) < 16) add(`input ${describe(el)} is ${getComputedStyle(el).fontSize}`);
      }
    }
  }
  return out;
}

/**
 * Every open dialog, drawer and sheet fits the window it is in: inside the overlay gutter, with its
 * close button on screen, reachable, under the desktop app's window controls and not under anything,
 * a title that cannot push it out, footer buttons that are not clipped, no control cut by an
 * `overflow` ancestor, no sideways overflow and no scroller inside a scroller. On a phone it also
 * holds the 44 px targets and the 16 px inputs.
 */
export async function overlayFit(page, { touch = false } = {}) {
  return page.eval(`return (${overlayFitInPage.toString()})(${JSON.stringify({ touch })})`);
}
