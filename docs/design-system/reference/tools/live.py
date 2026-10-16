# The chat with what it delegates in sight, and a tool call that reads as what happened:
# DesktopChatEnMarcha, MobileChatEnMarcha, MobileChatEnMarchaLista, DesktopChatLlamadas and
# MobileChatLlamadas (plans/tool-rows-and-live-branches.md §3). Run after desktop.py; it imports common.
from common import *

STEP_TOOLS = {'Agent': 'team', 'Bash': 'code', 'Read': 'docs', 'Edit': 'edit', 'Grep': 'search', 'WebFetch': 'link', 'kb_search_documents': 'package'}


def step_line(count, took, badges, current=False, open_=False):
  state = '<span class="spin-braille"></span>' if current else ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')
  chev = ico('down' if open_ else 'right', 'ico ico-sm')
  b = ''.join(f'<span class="badge">{x}</span>' for x in badges)
  return f'<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3); white-space: nowrap; min-width: 0">{state}<span style="flex: none">{count} herramientas · {took}</span><span class="row" style="gap: 6px; min-width: 0; overflow: hidden">{b}</span>{chev}</div>'


def call_head(tool, hint, outcome='ok', open_=False):
  spin = '<span class="spin-braille"></span>' if outcome == 'running' else ico(STEP_TOOLS.get(tool, 'package'), 'ico ico-sm')
  failed = '<span class="call-outcome">ha fallado</span>' if outcome == 'error' else ''
  chev = ico('down' if open_ else 'right', 'ico ico-sm', 'margin-left: auto; flex: none')
  return f'<div class="call-head" role="button" aria-expanded="{str(open_).lower()}">{spin}<span class="tool-name">{tool}</span><span class="tool-hint">{hint}</span>{failed}{chev}</div>'


def call(tool, hint, body='', outcome='ok', open_=False):
  return f'<div class="call-row is-{outcome}">{call_head(tool, hint, outcome, open_)}{f"<div class=\"call-body\">{body}</div>" if open_ else ""}</div>'


def zone(label, inner):
  return f'<div class="call-zone"><span class="call-label">{label}</span>{inner}</div>'


def code(lines, start=1, lang=''):
  rows = ''.join(f'<span class="ln">{start + i}</span><span class="tx">{l}</span>' for i, l in enumerate(lines))
  return f'<div class="code-ed" style="font-size: 12px; line-height: 1.6">{rows}</div>'


RAW = f'<button type="button" class="btn btn-ghost btn-sm call-raw">En bruto</button>'
MORE = lambda n: f'<button type="button" class="btn btn-ghost btn-sm call-more">Mostrar las {n} líneas</button>'


def launch(kind, name, status, facts, mark=None, bar=''):
  icon = {'agent': 'team', 'task': 'code', 'workflow': 'flow'}[kind]
  mk = f'<span class="chat-launch-mark">{mark}</span>' if mark else f'<span class="chat-launch-mark">{ico(icon, "ico ico-sm")}</span>'
  word = {'running': 'trabajando', 'completed': 'terminado', 'failed': 'ha fallado', 'stopped': 'detenido'}[status]
  spin = '<span class="spin-braille"></span>' if status == 'running' else (ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4') if status == 'completed' else ico('warn', 'ico ico-sm c-bad'))
  rail = ' rail-live is-running' if status == 'running' else ''
  return f'''<div class="chat-launch is-{kind}{rail}">
<div class="chat-launch-head">{mk}<span class="chat-launch-what"><span class="chat-launch-name ellipsis">{name}</span><span class="chat-launch-state">{spin}<span class="chat-launch-status is-{status}">{word}</span><span class="chat-launch-facts">{facts}</span></span></span><button type="button" class="btn btn-sm chat-launch-open">Abrir{ico('right', 'ico ico-sm')}</button></div>{bar}
</div>'''


def branch_row(kind, desc, act='', time='', status='running', nested=False):
  word = {'running': '', 'completed': 'terminado', 'failed': 'ha fallado', 'stopped': 'detenido'}[status]
  state = '<span class="spin-braille"></span>' if status == 'running' else (ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4') if status == 'completed' else ico('warn', 'ico ico-sm c-bad'))
  w = f'<span class="word">{word}</span>' if word else ''
  return f'<button type="button" class="chat-branch-row is-{status}{" is-nested" if nested else ""}" aria-label="Abrir {desc}"><span class="state">{state}</span>{w}<span class="badge chat-branch-kind">{kind}</span><span class="chat-branch-desc">{desc}</span><span class="chat-branch-act">{act}</span><span class="chat-branch-time">{time}</span></button>'


ROWS = [
  branch_row('Explore', 'Investigar el stream del CLI', '<span class="verb">leyendo</span> packages/core/src/chats.ts', '0:42'),
  branch_row('bash', 'grep -rn parent_tool_use_id packages/core', '', '0:05', nested=True),
  branch_row('general-purpose', 'Revisar el inspector del chat', '<span class="verb">buscando</span> BranchesCard', '0:31'),
  branch_row('bash', 'Ejecutar la suite', '', '1:10'),
  branch_row('Explore', 'Leer el plan de chat-experience', '', '0:48', status='completed'),
]

BAR = lambda open_, mobile=False: f'<button type="button" class="chat-branches-bar" aria-expanded="{str(open_).lower()}"><span class="spin-braille"></span><span class="chat-branches-count">2 agentes · 1 tarea en segundo plano</span><span class="chat-branches-now">Explore · <span class="verb">leyendo</span> packages/core/src/chats.ts · 0:42</span>{ico("down", "ico ico-sm fg-3", "" if open_ else "transform: rotate(180deg)")}</button>'

STRIP_OPEN = f'<div class="chat-branches">{BAR(True)}<div class="chat-branches-list" aria-label="En marcha">{"".join(ROWS)}</div></div>'
STRIP_CLOSED = f'<div class="chat-branches">{BAR(False)}</div>'

ASK = 'Investiga cómo se pintan las llamadas a herramientas en el chat y qué pasa con los subagentes, y lanza la investigación en paralelo.'

CARD_DONE = launch('agent', 'Leer el plan de chat-experience', 'completed', 'Explore · 48 s')
CARD_RUN = launch('agent', 'Investigar el stream del CLI', 'running', 'Explore · <span class="verb c-live">leyendo</span> packages/core/src/chats.ts · 0:42')
CARD_TASK = launch('task', 'Ejecutar la suite', 'running', 'pnpm test · 1:10')


def transcript_running(mobile=False):
  fs = 'font-size: 15px; line-height: 1.6' if mobile else 'font-size: 14px; line-height: 1.65'
  bubble = f'<div style="align-self: flex-end; max-width: 82%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px">{ASK}</div>'
  step1 = step_line(3, '52 s', ['kb_search_documents', 'Agent', 'Bash'])
  p1 = '<p style="margin: 0">El plan de chat-experience ya explica cómo se agrupan las llamadas en pasos. Lanzo dos agentes en paralelo y la suite en segundo plano mientras leo el inspector.</p>'
  step2 = step_line(3, '1 min 12 s', ['Agent ×2', 'Bash'], current=True, open_=True)
  calls = ''.join([
    call('Agent', 'Investigar el stream del CLI', outcome='running'),
    call('Agent', 'Revisar el inspector del chat', outcome='running'),
    call('Bash', 'Ejecutar la suite', outcome='ok'),
  ])
  working = '<div class="row t-sm" style="gap: 8px; white-space: nowrap; min-width: 0"><span class="spin-braille"></span><span class="shimmer" style="font-weight: 500; flex: none">Claude Code está delegando</span><span class="mono t-xs fg-3 ellipsis">Revisar el inspector del chat · 0:31</span></div>'
  if mobile:
    return f'''<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 16px 16px 0; gap: 14px; {fs}">
{step1}
{CARD_DONE}
{p1}
<div class="col rail-live" style="gap: 8px; padding-left: 10px">{step2}<div class="col" style="gap: 2px">{calls}</div></div>
{CARD_RUN}
{working}
</div>'''
  return f'''<div class="col" style="width: 100%; max-width: 740px; gap: 16px; {fs}">
{bubble}
{step1}
{CARD_DONE}
{p1}
<div class="col rail-live" style="gap: 8px; padding-left: 10px">{step2}<div class="col" style="gap: 2px">{calls}</div></div>
{CARD_RUN}
{CARD_TASK}
{working}
</div>'''


def composer(mobile=False, energy=True):
  if mobile:
    return f'''<div class="col" style="flex-shrink: 0; padding: 10px 16px 24px; gap: 10px">
<div class="row" style="gap: 6px"><button type="button" class="chip">Opus 5.5</button><button type="button" class="chip">Sin permisos</button><button type="button" class="chip">MCP</button></div>
<div class="card{' energy' if energy else ''}" style="border-radius: var(--r-xl); padding: 8px 8px 8px 6px; display: flex; align-items: center; gap: 6px"><button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Añadir al mensaje">{ico('plus', 'ico ico-lg')}</button><span class="grow fg-3" style="font-size: 16px">Envía un mensaje</span><button type="button" class="btn btn-danger btn-icon btn-lg" aria-label="Interrumpir" style="border-radius: var(--r-full)"><svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"></path></svg></button></div>
</div>'''
  return f'''<div class="col" style="width: 100%; max-width: 780px; gap: 8px">
<div class="card{' energy' if energy else ''}" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<button type="button" class="btn btn-ghost btn-icon" aria-label="Añadir al mensaje">{ico('plus')}</button>
<label class="grow" style="display: flex; min-height: 36px; align-items: center"><textarea rows="1" placeholder="Envía un mensaje de seguimiento…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: 14px; padding: 0"></textarea></label>
{'<button type="button" class="btn btn-danger btn-sm" style="height: 36px"><svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"></path></svg>Detener</button>' if energy else ''}
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico('send', 'ico', 'stroke-width: 2.2')}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip">Opus 5.5</button><button type="button" class="chip">Sin pedir permisos</button><button type="button" class="chip">Sin preset</button><button type="button" class="chip">MCP de la CLI</button><span class="grow"></span><span class="t-xs fg-3 mono">↵ enviar · ⇧↵ salto</span></div>
</div>'''


def aside(running=True):
  state = '<span class="badge b-live"><span class="spin-braille" style="width: auto"></span>trabajando</span>' if running else '<span class="badge">inactivo</span>'
  return f'''<aside aria-label="Detalles del chat" class="col" style="width: 344px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--bg-1); gap: 0">
<div class="tabs" role="tablist" style="padding: 8px 16px 0; height: 56px; align-items: flex-end"><button type="button" role="tab" aria-selected="true" class="tab on">Resumen</button><button type="button" role="tab" aria-selected="false" class="tab">Actividad</button><button type="button" role="tab" aria-selected="false" class="tab">Cambios</button><button type="button" role="tab" aria-selected="false" class="tab">Entorno</button></div>
<div class="col" style="padding: 18px; gap: 22px">
<section class="row" style="gap: 14px"><span class="ring" style="--p: 14; --c: var(--fg-2); width: 60px; height: 60px; font-size: 12px">14%</span><span class="col" style="gap: 3px"><span class="t-label">Contexto</span><span class="t-sm">144.826 de 1 M tokens</span></span></section>
<section class="col" style="gap: 0">
<span class="t-label" style="padding-bottom: 8px">Chat</span>
<div class="prop-row"><span class="k" style="width: 90px">Estado</span><span class="v">{state}</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Modo</span><span class="v">Interactivo</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Permisos</span><span class="v"><span class="badge">bypassPermissions</span></span></div>
<div class="prop-row"><span class="k" style="width: 90px">Coste</span><span class="v t-num">2,55 US$</span></div>
<div class="prop-row"><span class="k" style="width: 90px">Mensajes</span><span class="v t-num">109</span></div>
</section>
</div>
</aside>'''


def head(title, running=True):
  pill = '<span class="badge b-live"><span class="spin-braille" style="width: auto"></span>trabajando · 1:12</span>' if running else '<span class="badge">inactivo · interactivo</span>'
  return f'''<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopChats.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver a chats">{ico('left')}</a>
<span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis" style="font-weight: 600">{title}</span><span class="mono t-xs fg-3">claudio · 42281d · opus-5.5</span></span>
{pill}
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>'''


def running_desktop():
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow" style="gap: 0; min-width: 0">
{head('Investiga cómo se pintan las llamadas a herramientas en el chat')}
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 20px 32px 0">
{transcript_running()}
</div>
<div style="display: flex; justify-content: center; padding: 8px 32px 0; flex-shrink: 0">{STRIP_OPEN}</div>
<div style="display: flex; justify-content: center; padding: 10px 32px 18px; flex-shrink: 0">{composer()}</div>
</div>
{aside()}
</div>'''
  write('DesktopChatEnMarcha.html', desktop('Chat con subagentes en marcha', 'chats', '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">42281d</span>', main, agents=3, running=3))


def mobile_head():
  return f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 2px; min-width: 0"><span class="ellipsis" style="font-weight: 600; font-size: 16px; line-height: 1.3">Investiga cómo se pintan las llamadas</span><span class="row t-xs mono" style="gap: 6px"><span class="spin-braille"></span><span class="c-live">trabajando · 1:12</span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Detalles">{ico('info', 'ico ico-lg')}</button>
</header>'''


def running_mobile():
  inner = f'''{mobile_head()}
{transcript_running(True)}
{STRIP_CLOSED}
{composer(True)}'''
  write('MobileChatEnMarcha.html', mobile('Chat con subagentes en marcha', inner))
  sheet = f'''<div style="position: absolute; inset: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 60%, transparent)"></div>
<div class="sheet" role="dialog" aria-label="En marcha" style="z-index: 11; padding-bottom: 34px">
<div class="grab"></div>
<div class="row" style="margin: 0 4px 10px"><span style="font-weight: 600; font-size: 16px" class="grow">En marcha</span><span class="mono t-xs fg-3">2 agentes · 1 tarea</span></div>
<div class="col" style="gap: 2px">{''.join(ROWS)}</div>
<button type="button" class="btn btn-ghost btn-lg" style="height: 52px; margin-top: 8px">Ocultar</button>
</div>'''
  inner2 = f'''{mobile_head()}
{transcript_running(True)}
{STRIP_CLOSED}
{composer(True)}
{sheet}'''
  write('MobileChatEnMarchaLista.html', mobile('En marcha, la lista', inner2, cls='m-sheet'))


# ---- the opened tool rows ----

BASH_BODY = (zone('Llamada', code(['node -v &amp;&amp; grep -n \'"engines"\' -A2 package.json'], lang='bash') + '<div class="call-meta"><span>timeout 120 s</span></div>')
  + zone('Resultado', '<pre class="call-term">v22.21.1\n3:  "engines": {\n4:    "node": ">=22"\n5:  },</pre>')
  + zone('Errores', '<pre class="call-stderr">(eval):1: no matches found: --include=*.ts</pre>') + RAW)

READ_BODY = zone('Resultado', code(['<span class="sx-kw">import</span> type { ContentBlock, TranscriptEntry } <span class="sx-kw">from</span> <span class="sx-str">\'./types.ts\'</span>;', '', '<span class="sx-kw">const</span> MAX_TOOL_RESULT = <span class="sx-num">20_000</span>;', '', '<span class="sx-kw">function</span> <span class="sx-fn">stringifyToolResult</span>(content: unknown): string {', '  <span class="sx-kw">if</span> (<span class="sx-kw">typeof</span> content === <span class="sx-str">\'string\'</span>) <span class="sx-kw">return</span> content;'], start=1)) + MORE(128)

DIFF_ROWS = [
  ('ctx', '36', '36', '      case \'tool_result\': {'),
  ('ctx', '37', '37', '        const text = stringifyToolResult(b.content);'),
  ('del', '38', '', '        blocks.push({ type: \'tool_result\', toolUseId: String(b.tool_use_id ?? \'\'), content: text, isError: b.is_error === true });'),
  ('add', '', '38', '        const detail = toolResultDetail(raw.tool_use_result ?? raw.toolUseResult);'),
  ('add', '', '39', '        blocks.push({ type: \'tool_result\', toolUseId: String(b.tool_use_id ?? \'\'), content: text, isError: b.is_error === true, ...(detail ? { detail } : {}) });'),
  ('ctx', '39', '40', '        break;'),
]


def diff_block():
  rows = ''
  for kind, a, b, t in DIFF_ROWS:
    rail = {'ctx': 'transparent', 'del': 'var(--diff-del)', 'add': 'var(--diff-add)'}[kind]
    bg = {'ctx': 'transparent', 'del': 'var(--diff-del-bg)', 'add': 'var(--diff-add-bg)'}[kind]
    fg = 'var(--fg-3)' if kind == 'ctx' else 'var(--fg)'
    sign = {'ctx': ' ', 'del': '−', 'add': '+'}[kind]
    rows += f'<div style="display: grid; grid-template-columns: 3px 40px 40px 16px minmax(0, 1fr); align-items: stretch; height: 20px; background: {bg}"><i style="background: {rail}"></i><span style="color: {rail if kind != "ctx" else "var(--fg-3)"}; text-align: right; padding-right: 8px">{a}</span><span style="color: {rail if kind != "ctx" else "var(--fg-3)"}; text-align: right; padding-right: 8px">{b}</span><span style="color: {fg}">{sign}</span><span style="color: {fg}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{t}</span></div>'
  return f'<div class="call-diff" style="font-family: var(--mono); font-size: 12px; line-height: 20px; padding: 4px 0">{rows}</div>'


EDIT_BODY = zone('Cambio', diff_block() + '<div class="call-meta"><span>packages/shared/src/normalize.ts</span><span class="c-ok">+2</span><span class="c-bad">−1</span></div>') + RAW

GREP_BODY = (zone('Llamada', '<div class="call-meta"><span>parent_tool_use_id</span><span>en packages/core</span><span>output_mode files</span></div>')
  + zone('Resultado', '<ul class="call-files"><li>packages/core/src/providers/claude-code/stream.ts</li><li>packages/core/src/providers/claude-code/branches.ts</li><li>packages/core/src/chat-fold.ts</li><li>packages/shared/src/normalize.ts</li></ul>') + RAW)

AGENT_BODY = (zone('Llamada', '<div class="row" style="gap: 6px"><span class="badge">Explore</span><span class="badge">opus</span><span class="badge">en segundo plano</span></div><div class="row t-xs fg-3" style="gap: 6px; font-family: var(--mono)">' + ico('right', 'ico ico-sm') + '<span>Instrucciones</span></div>')
  + zone('Resultado', '<span class="t-sm fg-2">Lanzado en segundo plano</span>' + launch('agent', 'Investigar el stream del CLI', 'completed', 'Explore · 2 min 4 s')) + RAW)

MCP_BODY = (zone('Llamada', '<div class="call-fields"><span class="call-field-key">query</span><span class="call-field">how tool calls are rendered in the chat transcript</span><span class="call-field-key">limit</span><span class="call-field mono">8</span></div>')
  + zone('Resultado', '<ul class="call-tree"><li><span class="k">count</span> <span class="v n">8</span></li><li><span class="k">results</span> <span class="fg-3">[8]</span><ul class="call-tree"><li><span class="k">file_path</span> <span class="v">plans/ui-redesign.md</span></li><li><span class="k">score</span> <span class="v n">0.0164</span></li><li><span class="k">chunk_content</span> <span class="v">"The transcript shows the author only when it changes, groups consecutive tool calls into a step…"</span></li></ul></li></ul>') + RAW)


def calls_open(mobile=False, second=False):
  items = [
    call('Bash', 'Comprobar la versión de Node', BASH_BODY, open_=True),
    call('Read', 'packages/shared/src/normalize.ts:1–40', READ_BODY, open_=True),
    call('Edit', 'packages/shared/src/normalize.ts', EDIT_BODY, open_=True),
    call('Grep', 'parent_tool_use_id · packages/core', GREP_BODY, open_=True),
    call('Agent', 'Investigar el stream del CLI', AGENT_BODY, open_=True),
    call('kb_search_documents', 'how tool calls are rendered in the chat transcript', MCP_BODY, open_=True),
  ]
  items = items[3:] if second else items[:3]
  if mobile:
    items = [items[1], items[2]] if second else [items[0], items[2]]
  return ''.join(items)


def calls_desktop(second=False):
  transcript = f'''<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: 14px; line-height: 1.65">
<div style="align-self: flex-end; max-width: 82%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px">Añade el detalle estructurado al resultado de cada herramienta.</div>
<div class="col" style="gap: 8px">{step_line(6, '2 min 3 s', ['Bash', 'Read', 'Edit', 'Grep', 'Agent', 'kb_search_documents'], open_=True)}<div class="col" style="gap: 2px">{calls_open(second=second)}</div></div>
</div>'''
  main = f'''<div class="row" style="flex: 1 1 auto; min-height: 0; align-items: stretch; gap: 0">
<div class="col grow" style="gap: 0; min-width: 0">
{head('Añade el detalle estructurado al resultado de cada herramienta', running=False)}
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 20px 32px 0">
{transcript}
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 18px; flex-shrink: 0">{composer(energy=False)}</div>
</div>
{aside(running=False)}
</div>'''
  write('DesktopChatLlamadasMas.html' if second else 'DesktopChatLlamadas.html', desktop('Las llamadas, abiertas', 'chats', '<a href="DesktopChats.html" class="fg-2">Chats</a><span class="fg-3">/</span><span class="mono" style="font-weight: 500">42281d</span>', main, agents=2, running=2))


def calls_mobile(second=False):
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 2px; min-width: 0"><span class="ellipsis" style="font-weight: 600; font-size: 16px; line-height: 1.3">Añade el detalle estructurado</span><span class="row t-xs mono fg-3" style="gap: 6px">inactivo · interactivo</span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Detalles">{ico('info', 'ico ico-lg')}</button>
</header>
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 16px 12px 0; gap: 12px; font-size: 15px; line-height: 1.6">
{step_line(6, '2 min 3 s', ['Bash', 'Edit', 'kb_search…'], open_=True)}
<div class="col" style="gap: 2px">{calls_open(True, second)}</div>
</div>
{composer(True, energy=False)}'''
  write('MobileChatLlamadasMas.html' if second else 'MobileChatLlamadas.html', mobile('Las llamadas, abiertas', inner))


if __name__ == '__main__':
  running_desktop(); running_mobile(); calls_desktop(); calls_desktop(True); calls_mobile(); calls_mobile(True)
