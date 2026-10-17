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
 * I11: everything that takes focus shows it, with an outline or a ring. A field drawn inside a
 * bordered wrapper (search, number input) has its ring on the wrapper's :focus-within, so the
 * nearest ancestors count; `closest()` would return the focused element itself, which also matches
 * :focus-within, and miss every such ring.
 */
export async function invisibleFocus(page) {
  return page.eval(
    DESCRIBE +
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
      `before?.focus?.({preventScroll:true});return out.slice(0,20)`,
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
