// Content wider than the box it sits in (docs/design-system.md, "Truncation and scroll"). The UI
// invariants' I2 forgives an overflow as soon as any ancestor clips or scrolls, which is exactly how
// a tag ran past its step card into a pane that then scrolled sideways: the pane "managed" it. This
// asks three kinds of box on their own, as docs/plans/agent-messages.md describes the guard:
//
//   - the page: the document never scrolls sideways;
//   - the panes: a box that scrolls (overflow auto or scroll, which overflow-y auto implies for x)
//     never has more width than it shows;
//   - the list rows and cards: their content is never wider than they are.
//
// It forgives only what is wide on purpose: a block that scrolls sideways by design (code, a diff, a
// table, a terminal, a strip of tabs or segments, or anything inside an element marked
// `data-scroll-x`). Text cut by an ellipsis does not count: its own box clips it, so it adds nothing
// to its row's width (the invariants' I3 asks that it carries its full text).

const SCAN = `
const describe=(el)=>{const c=[...el.classList].slice(0,3).join('.');const t=(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);return el.tagName.toLowerCase()+(c?'.'+c:'')+(t?' "'+t+'"':'')};
const WIDE='[data-scroll-x],pre,code,table,textarea,.diff,.xterm,.cm-editor,svg,canvas,[role=tablist],.tabs,.segmented,.react-flow';
const ROWS='li,.card,.workitem-card,[role=row],[role=listitem],.edit-step,.crow-link,.workitem-mrow,.orch-card,.settings-row,.list-row';
const out=[];
const doc=document.documentElement;
if(doc.scrollWidth>doc.clientWidth+1)out.push('the page scrolls sideways ('+doc.clientWidth+'→'+doc.scrollWidth+'px)');
// The widest descendant that reaches past the box: where to look
const culprit=(el)=>{const right=el.getBoundingClientRect().right+1.5;let found=null;for(const d of el.querySelectorAll('*')){if(d.closest(WIDE)&&d.closest(WIDE)!==el&&el.contains(d.closest(WIDE)))continue;const r=d.getBoundingClientRect();if(r.width&&r.right>right){found=d}}return found};
for(const el of document.querySelectorAll('body *')){
  if(!el.getClientRects().length)continue;
  const w=el.clientWidth;if(w<=2)continue;
  if(el.scrollWidth<=w+1)continue;
  const s=getComputedStyle(el);
  if(s.visibility==='hidden'||s.display==='none')continue;
  const r=el.getBoundingClientRect();if(r.right<=0||r.left>=innerWidth||r.width===0)continue;
  if(el.closest(WIDE))continue;
  const pane=/auto|scroll/.test(s.overflowX);
  if(!pane&&!el.matches(ROWS))continue;
  const c=culprit(el);
  out.push(describe(el)+(pane?' scrolls sideways':' is wider than its row')+' ('+w+'→'+el.scrollWidth+'px)'+(c?' because of '+describe(c):''));
}
return out.slice(0,25);`;

/** The page, the panes and the list rows whose content is wider than they are, wide-on-purpose blocks aside */
export async function sidewaysOverflow(page) {
  return page.eval(SCAN);
}
