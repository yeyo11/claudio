// Content wider than the box it sits in (docs/design-system.md, "Truncation and scroll"). The UI
// invariants' I2 forgives an overflow as soon as any ancestor clips or scrolls, which is exactly how
// a tag ran past its step card into a pane that then scrolled sideways: the pane "managed" it. This
// asks each box on its own, and only forgives what is meant to be wide:
//
//   - a block that scrolls sideways on purpose: code, a diff, a table, a terminal, or anything
//     inside an element marked `data-scroll-x`;
//   - text cut by an ellipsis or a line clamp (the invariants' I3 asks that it carries its full text);
//   - what is hidden from sight (sr-only, zero-size, off-screen until focused).
//
// Each finding names the element, the kind and the widths, so a failure says where to look.

const SCAN = `
const describe=(el)=>{const c=[...el.classList].slice(0,3).join('.');const t=(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);return el.tagName.toLowerCase()+(c?'.'+c:'')+(t?' "'+t+'"':'')};
const SCROLL_OK='[data-scroll-x],pre,code,table,textarea,.diff,.xterm,.cm-editor,svg,canvas,[role=tablist],.tabs,.segmented';
const out=[];
const doc=document.documentElement;
if(doc.scrollWidth>doc.clientWidth+1)out.push('the page scrolls sideways ('+doc.clientWidth+'→'+doc.scrollWidth+'px)');
for(const el of document.querySelectorAll('body *')){
  if(!el.getClientRects().length)continue;
  const w=el.clientWidth;if(w<=2)continue;
  if(el.matches('.sr-only'))continue;
  const extra=el.scrollWidth-w;if(extra<=1)continue;
  const s=getComputedStyle(el);
  if(s.visibility==='hidden'||s.display==='none'||s.display==='contents')continue;
  const r=el.getBoundingClientRect();if(r.right<=0||r.left>=innerWidth||r.bottom<=0||r.top>=innerHeight*4)continue;
  if(el.closest(SCROLL_OK))continue;
  if(s.textOverflow==='ellipsis'||(s.webkitLineClamp&&s.webkitLineClamp!=='none'))continue;
  // A scroller that does not scroll sideways: overflow-y auto turns overflow-x auto as well
  const kind=/auto|scroll/.test(s.overflowX)?'scrolls sideways':s.overflowX==='visible'?'spills out':'cuts its content';
  // A spill is reported where it starts: the box whose own children are wider, not every ancestor
  let culprit=null;
  for(const c of el.children){const cr=c.getBoundingClientRect();if(cr.width&&cr.right>r.right+1.5){culprit=c;break}}
  // A header that bleeds into the page's padding with negative margins does so on purpose
  if(culprit){const cs=getComputedStyle(culprit);if(parseFloat(cs.marginRight)<0&&culprit.getBoundingClientRect().right<=r.right-parseFloat(cs.marginRight)+1.5)continue}
  if(kind==='spills out'&&!culprit){const range=document.createRange();range.selectNodeContents(el);if(range.getBoundingClientRect().right<=r.right+1.5)continue}
  out.push(describe(el)+' '+kind+' ('+w+'→'+el.scrollWidth+'px)'+(culprit?' by '+describe(culprit):''));
}
return out.slice(0,25);`;

/** Every box whose content is wider than it, except blocks wide on purpose and text with an ellipsis */
export async function sidewaysOverflow(page) {
  return page.eval(SCAN);
}
