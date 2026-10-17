"""The voice's mono rule (plans/claudio-designer.md section 1.2), applied to a screen's HTML.

Mono says "the machine reads this": ids, paths, model ids, commands, hashes, branch names, env vars, code and
keys. The screens were drawn when every meta line was mono, so `write()` passes each one through `apply()`: an
element marked mono (the `.mono` class or an inline `font-family: var(--mono)`) whose text is all literal
keeps it; one with no literal goes sans and tabular (`.t-num`); a mixed one goes sans with each literal run
wrapped in `<span class="mono">`. Code views, diffs, terminals and keys are left alone. It is idempotent, so a
screen can go through it again. `python3 voice.py '../*.html'` rewrites the reference in place.
"""
import re, sys, html

KEYS = set('↵⇧⌘⌥⌃⎋⇥←→↑↓')
WORDS = {'pnpm','npm','npx','node','test','gh','glab','git','log','origin','main','haiku','sonnet','opus',
         'GET','POST','PUT','PATCH','DELETE','computing','draft','conflicts','behind','unchecked','addressing','fixing','waiting','approval','person','decision','unknown','pending','running','passed','failed','skipped','success','failure','neutral','cancelled','closed','merged','locked','diff','e2e','tsc','vitest','eslint','curl','claude'}
TOOLS = {'Agent','Bash','Read','Edit','Write','Grep','Glob','WebFetch','WebSearch','Explore','Task','TodoWrite','en','es'}
STANDALONE = {'welcome','chats','orchestrations','schedules','projects','board','team','install','connector','offline',
              'quota','limits','issues','reviewer','i18n','yeyo','dpacheco','ok','ready','live','warn','bad','idle','full',
              'worktree','reviews','checks','web','api','release','labels','repo','status','auth','version','push','pull',
              'merge','fetch','commit','branch','tests'}
NAMES = {'claude-wrapper','pagos-api','google-docs-mcp','ecosystem-foundation','youtrack-app','obra10','spanish-copy'}
BRANDS = {'GitHub','GitLab','YouTrack','JetBrains','OpenAPI','TypeScript','JavaScript','PostgreSQL','SQLite','DevTools','WebSocket','McDonald'}
EN = {'the','of','by','a','an','to','be','or','its','hit','for','is','not','on','it','as','was','should','no','such','found','command','by','from','with','in'}

def lit(tok):
    t = tok.strip(',;:()[]«»"\'')
    if not t: return False
    if t in NAMES: return False
    if all(c in KEYS for c in t): return True
    if t in WORDS: return True
    if re.fullmatch(r'v?\d+\.\d+\.\d+[\w.-]*', t): return True
    if re.fullmatch(r'[0-9a-f]{6,40}', t) and re.search(r'\d', t) and re.search(r'[a-f]', t): return True
    if re.fullmatch(r'#[0-9a-fA-F]{3,8}', t): return True
    if re.fullmatch(r'[#!]\d+', t): return True
    if t.startswith(('@', '~', '$', '--', '/')) and len(t) > 1: return True
    if re.match(r'\.[A-Za-z_]', t): return True
    if re.match(r'-[a-zA-Z]', t): return True
    if re.search(r'\d', t) and re.fullmatch(r'[\d.,:%+−\-–/×]+[a-zº]{0,3}', t): return False
    if '/' in t and re.search(r'[A-Za-z]', t): return True
    if '_' in t: return True
    if re.search(r'[A-Za-z0-9]\.[A-Za-z0-9]', t) and not re.fullmatch(r'\d{1,3}(\.\d{3})+', t): return True
    if re.search(r'[a-z0-9]-[a-z0-9]', t) and re.search(r'[a-z]', t): return True
    if re.fullmatch(r'[A-Z][A-Z0-9]*-\d+', t): return True
    if re.fullmatch(r'[A-Z][A-Za-z]*(-[A-Z][A-Za-z]*)+', t): return True
    if re.fullmatch(r'[0-9a-f]{6,40}', t) and re.search(r'\d', t) and re.search(r'[a-f]', t): return True
    if re.fullmatch(r'[0-9a-f]{6,}…[0-9a-f]+', t): return True
    if re.fullmatch(r'[a-z]+[A-Z]\w*(\(\))?', t) or re.fullmatch(r'\w+\(\)', t): return True
    if re.fullmatch(r'[A-Z][A-Z0-9]*(_[A-Z0-9]+)+', t): return True
    if re.fullmatch(r'•+\w*', t): return True
    if re.fullmatch(r'[A-Z][a-z]+[A-Z]\w*', t) and t not in BRANDS: return True
    if re.fullmatch(r'[A-Z]{6,}', t): return True
    if re.fullmatch(r'[A-Z]{2,5}', t) and t not in {'CC','CI','QA','PR','MR','API','CLI','US','KB','MB','IA','AI','SSH','URL','MCP'}: return True  # work item prefixes AGN, PAG, CW
    return False

def english(text):
    w = re.findall(r'[A-Za-z]+', text.lower())
    return len(w) >= 3 and sum(x in EN for x in w) >= 2 and not re.search(r'[áéíóúñ¿¡]', text)

def classify(text):
    """'keep' if the text is all literal, 'sans' if none of it is, else a list of (is_lit, chunk)."""
    s = html.unescape(text).strip()
    if not s: return 'empty'
    if s in STANDALONE or s in TOOLS: return 'keep'
    if english(s): return 'keep'
    m = re.fullmatch(r'(\s*)(\w+)( ×\d+\s*)', text)
    if m and m.group(2) in TOOLS: return [(None, m.group(1)), (True, m.group(2)), (False, m.group(3))]
    parts = re.split(r'(\s+)', text)
    flags = []
    for p in parts:
        if not p or p.isspace(): flags.append(None); continue
        u = html.unescape(p)
        flags.append(lit(u) or (u == '→'))
    toks = [f for f in flags if f is not None]
    if all(toks): return 'keep'
    if not any(toks): return 'sans'
    # an arrow is literal only between two literals
    idx = [i for i, f in enumerate(flags) if f is not None]
    for k, i in enumerate(idx):
        if html.unescape(parts[i]) == '→':
            prev = flags[idx[k-1]] if k > 0 else False
            nxt = flags[idx[k+1]] if k + 1 < len(idx) else False
            flags[i] = bool(prev and nxt and lit(html.unescape(parts[idx[k-1]])) and lit(html.unescape(parts[idx[k+1]])))
    return list(zip(flags, parts))

def render(chunks):
    out, run = [], []
    def flush():
        if run:
            body = ''.join(run); tail = re.search(r'\s*$', body).group(0); body = body[:len(body)-len(tail)]
            out.append(f'<span class="mono">{body}</span>{tail}'); run.clear()
    for f, p in chunks:
        if f is None:
            (run if run else out).append(p)
        elif f:
            m = re.fullmatch(r'([(«"]*)(.*?)([,;:)»"]*)', p, re.S)
            if m.group(1): flush(); out.append(m.group(1))
            run.append(m.group(2))
            if m.group(3): flush(); out.append(m.group(3))
        else:
            flush(); out.append(p)
    flush()
    return ''.join(out)

TOKEN = re.compile(r'<!--.*?-->|<[^>]+>|[^<]+', re.S)
VOID = {'br','img','input','meta','link','hr','wbr','source','col','area'}
SKIP = {'svg','code','pre','textarea','style','script','kbd'}
SKIP_CLS = r'(sx-|dv|code|term-|hand-text|call-term|call-stderr|call-diff|call-tree|call-files|permission-input|rt-evidence|check-tail|ochk-tail|rt-sugg|rt-hunk|diff-|kbd|wd$|il$)'
MONO_STYLE = re.compile(r'font-family:\s*var\(--mono\);?\s*')

def is_mono(tag):
    m = re.search(r'\sclass="([^"]*)"', tag)
    if m and 'mono' in m.group(1).split(): return True
    m = re.search(r'\sstyle="([^"]*)"', tag)
    return bool(m and MONO_STYLE.search(m.group(1)))

def unmono(tag):
    def cls(m):
        c = [x for x in m.group(1).split() if x != 'mono']
        if 't-num' not in c: c.insert(0, 't-num')
        return f' class="{" ".join(c)}"'
    had = bool(re.search(r'\sclass="', tag))
    tag = re.sub(r'\sclass="([^"]*)"', cls, tag, count=1)
    def sty(m):
        v = MONO_STYLE.sub('', m.group(1)).strip()
        v = re.sub(r';\s*$', '', v)
        return f' style="{v}"' if v else ''
    tag = re.sub(r'\sstyle="([^"]*)"', sty, tag, count=1)
    if not had:
        tag = re.sub(r'^<(\w+)', r'<\1 class="t-num"', tag)
    return tag

def process(src):
    toks = TOKEN.findall(src)
    assert ''.join(toks) == src
    # build tree
    root = {'tag': None, 'i': None, 'kids': [], 'mono': False, 'skip': False}
    stack = [root]
    for i, t in enumerate(toks):
        if t.startswith('<!--'): continue
        if t.startswith('</'):
            mm = re.match(r'</\s*(\w+)', t)
            if not mm: continue
            name = mm.group(1).lower()
            for k in range(len(stack)-1, 0, -1):
                if stack[k]['tag'] == name:
                    del stack[k:]; break
            continue
        if t.startswith('<'):
            m = re.match(r'<\s*([\w-]+)', t)
            if not m: continue
            name = m.group(1).lower()
            par = stack[-1]
            cm = re.search(r'\sclass="([^"]*)"', t)
            codey = bool(cm and any(re.match(SKIP_CLS, c) for c in cm.group(1).split()))
            node = {'tag': name, 'i': i, 'kids': [], 'mono': is_mono(t), 'skip': par['skip'] or name in SKIP or codey}
            par['kids'].append(node)
            # An input says what it holds through its value: a typed amount or count is not a literal
            vm = re.search(r'\svalue="([^"]*)"', t)
            if name == 'input' and node['mono'] and not node['skip'] and vm and classify(vm.group(1)) == 'sans':
                toks[i] = unmono(t)
            if name not in VOID and not t.endswith('/>'):
                stack.append(node)
            continue
        stack[-1]['kids'].append(i)
    changes = []
    def governed(node):
        for k in node['kids']:
            if isinstance(k, int): yield k
            elif not k['mono'] and not k['skip']: yield from governed(k)
    def walk(node):
        for k in node['kids']:
            if isinstance(k, dict):
                if k['mono'] and not k['skip']:
                    texts = [j for j in governed(k) if toks[j].strip()]
                    kinds = [classify(toks[j]) for j in texts]
                    if any(toks[j].strip() == '$' for j in texts): texts = []
                    if texts and not all(x in ('keep', 'empty') for x in kinds):
                        old = toks[k['i']]
                        toks[k['i']] = unmono(old)
                        for j, kind in zip(texts, kinds):
                            if isinstance(kind, list):
                                toks[j] = render(kind)
                            elif kind == 'keep':
                                lead = re.match(r'\s*', toks[j]).group(0); tail = re.search(r'\s*$', toks[j]).group(0)
                                body = toks[j][len(lead):len(toks[j])-len(tail)]
                                toks[j] = f'{lead}<span class="mono">{body}</span>{tail}'
                        changes.append(old)
                walk(k)
    walk(root)
    return ''.join(toks), changes

def apply(src):
    return process(src)[0]


if __name__ == '__main__':
    import glob
    for f in sorted(glob.glob(sys.argv[1] if len(sys.argv) > 1 else '../*.html')):
        s = open(f).read()
        out = apply(s)
        if out != s:
            open(f, 'w').write(out)
            print('voiced', f)
