# The Claudio assistant's entry (CW-30, CW-18 and CW-17): the global "Asistente" item, its /assistant screen with
# Claudio's illustration, the greeting, the composer, the starters and the recents, and one assistant chat holding a
# write behind the host prompt (plans/assistant-mascot.md).
# Writes DesktopAsistenteClaudio, DesktopAsistenteClaudioChat, MobileAsistenteClaudio, MobileAsistenteClaudioChat and
# MobileAsistenteClaudioMas (the Más page with the new item, lifted from MobileMas.html).
# Runs on its own; imports common.py.
from common import *

PROJECT = 'claude-wrapper'
# The app's four starters (pages/claudio-assistant/model.ts), in its order
STARTERS = [
  ('tasks', 'Estado del tablero', '¿Qué hay abierto en el tablero y qué está bloqueado?'),
  ('orch', 'Orquestaciones', '¿Por qué ha fallado la última orquestación?'),
  ('flow', 'Flujo y equipo', '¿Qué tarjetas está esperando el equipo?'),
  ('usage', 'Uso y límites', '¿Cuánto he gastado hoy?'),
]
# The recents: the assistant's own chats, newest first. The word keeps its status colour and stands still; a chat
# at rest says nothing (the app gives screen readers "Inactivo")
RECENTS = [
  ('Crea una tarea en AGN para revisar los límites de las columnas', ('is-idle', 'Esperándote'), 'hace 2 min'),
  ('¿Por qué ha fallado la última orquestación?', ('is-bad', 'Fallida'), 'hace 1 h'),
  ('¿Cuánto he gastado esta semana?', None, 'hace 3 h'),
  ('¿Qué tarjetas está esperando el equipo?', None, 'hace 2 d'),
  ('Estado del tablero de AGN', None, 'hace 4 d'),
]
GREETING = 'Hola, soy Claudio'
SUB = 'Tu asistente. Te cuento cómo van tus proyectos, tareas, orquestaciones y el uso.'
HELLO_CHAT = 'Hola, soy Claudio, tu asistente. Pregúntame por tus proyectos, tareas, orquestaciones o el uso.'
PLACEHOLDER = 'Pregúntale a Claudio…'
ASK = 'Crea una tarea en AGN para revisar los límites de las columnas, prioridad media'


def mark(sm=False):
  # The neutral tile with Claudio's glyph: the Más row and the chat's top bar, where the mark is an icon
  return f'<span class="ai-mark{" sm" if sm else ""}" aria-hidden="true">{ico("claudio")}</span>'


# The colour mark (the app's ClaudioMascot, illustrations/claudio-mark.svg): where the assistant speaks
MASCOT = ('<svg class="mascot-mark" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">'
          '<rect x="2.5" y="6.5" width="12.5" height="17" rx="3.5" class="mascot-body"></rect>'
          '<ellipse cx="9.3" cy="12.2" rx="1.2" ry="1.65" class="mascot-eye"></ellipse><ellipse cx="12.5" cy="12.2" rx="1.2" ry="1.65" class="mascot-eye"></ellipse>'
          '<path transform="translate(19.2 5) scale(0.235)" class="mascot-spark" d="M0 -19Q6 -6 19 0Q6 6 0 19Q-6 6 -19 0Q-6 -6 0 -19Z"></path></svg>')

# The `claudio` illustration, as it is in illustrations/claudio.svg (the frame's defs, plus the logo's gradient)
CLAUDIO_BODY = '''<rect x="0" y="0" width="240" height="160" class="f-dots" mask="url(#il-fade)"></rect>
<ellipse cx="94" cy="141" rx="54" ry="5" class="ln-soft"></ellipse>
<g class="a-float"><rect x="83" y="74" width="32" height="54" rx="9" class="f-spark"></rect><g class="a-look"><ellipse cx="100.5" cy="90" rx="2.6" ry="3.6" class="f-eye"></ellipse><ellipse cx="109.5" cy="90" rx="2.6" ry="3.6" class="f-eye"></ellipse></g></g>
<path transform="translate(31 14) scale(1.1)" class="f-logo cut" d="M41.76 14.24Q46 10 52 10L71 10Q74 10 76.12 12.12L93.88 29.88Q96 32 93 32L57 32Q54 32 51.88 34.12L34.83 51.17Q32 54 32 58L32 62Q32 66 34.83 68.83L51.88 85.88Q54 88 57 88L93 88Q96 88 93.88 90.12L76.12 107.88Q74 110 71 110L52 110Q46 110 41.76 105.76L14.24 78.24Q10 74 10 68L10 52Q10 46 14.24 41.76Z"></path>
<g class="a-float-2"><path transform="translate(97 59) scale(0.4)" class="f-spark" d="M0 -19Q6 -6 19 0Q6 6 0 19Q-6 6 -19 0Q-6 -6 0 -19Z"></path></g>
<g class="a-float-2"><rect x="146" y="56" width="48" height="26" rx="13" class="c2"></rect><text x="158" y="73.5" class="txt-big">›</text><rect x="168" y="63" width="7" height="12" rx="1.5" class="f-ink a-blink"></rect></g>'''


def claudio_il(size):
  g, lg, d, fg, fm = 'il-grad', 'il-logo', 'il-dots', 'il-fade-g', 'il-fade'
  return (f'<svg class="il {size}" data-illustration="claudio" viewBox="0 0 240 160" aria-hidden="true"><defs><linearGradient id="{g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="stop-a"></stop><stop offset="1" class="stop-b"></stop></linearGradient>'
          f'<linearGradient id="{lg}" x1="0.35" y1="0" x2="0.6" y2="1"><stop offset="0" class="stop-logo-a"></stop><stop offset="0.5" class="stop-logo-a"></stop><stop offset="1" class="stop-logo-b"></stop></linearGradient>'
          f'<pattern id="{d}" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" class="dot-fill"></circle></pattern><radialGradient id="{fg}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" class="stop-in"></stop><stop offset="1" class="stop-out"></stop></radialGradient><mask id="{fm}"><rect x="0" y="0" width="240" height="160" fill="url(#{fg})"></rect></mask></defs>{CLAUDIO_BODY}</svg>')


def starter(s):
  icon, title, ask = s
  return f'<button type="button" class="as-starter">{ico(icon)}<span class="as-starter-body"><span class="as-starter-title">{title}</span><span class="as-starter-ask">{ask}</span></span></button>'


def recent(r):
  title, word, when = r
  if word:
    meta = f'<span class="as-recent-word {word[0]}">{word[1]}</span><span class="as-recent-sep" aria-hidden="true"> · </span>'
  else:
    meta = '<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">Inactivo</span>'
  return f'<li><a href="DesktopChat.html" class="as-recent"><span class="as-recent-title ellipsis">{title}</span><span class="as-recent-meta">{meta}<span class="as-recent-time">{when}</span></span></a></li>'


def recents(n):
  return (f'<section class="as-recents-section" aria-labelledby="as-recents-label"><div class="as-recents-head"><h2 id="as-recents-label" class="t-label">Recientes</h2>'
          f'<a href="DesktopChats.html" class="as-recents-all" aria-label="Ver todas las conversaciones con el asistente">Ver todas</a></div>'
          f'<ul class="as-recents">{"".join(recent(r) for r in RECENTS[:n])}</ul></section>')


def starters_section(items):
  return f'<section class="col" style="gap: 10px" aria-label="Para empezar"><span class="t-label">Para empezar</span><div class="as-starters">{"".join(starter(s) for s in items)}</div></section>'


def context_chip():
  return f'<span class="chip as-context">{ico("folder", "ico ico-sm")}<span class="ellipsis">Con {PROJECT} como contexto</span><button type="button" class="x" aria-label="Quitar el contexto">{ico("x", "ico ico-sm")}</button></span>'


def entry_composer(mobile=False):
  if mobile:
    return f'''<div class="col" style="flex-shrink: 0; padding: 10px 12px 12px; gap: 10px; border-top: 1px solid var(--line); background: var(--bg-1)">
<div class="row" style="gap: 6px">{context_chip()}<button type="button" class="chip">Sonnet</button></div>
<div class="card grad-border row" style="border-radius: var(--r-xl); padding: 4px; gap: 4px; align-items: flex-end">
<label class="grow" style="display: flex; min-height: var(--touch); align-items: center; padding-left: 12px"><textarea rows="1" placeholder="{PLACEHOLDER}" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: var(--fs-input); padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar" style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("send", "ico ico-lg", "stroke-width: 2.2")}</button>
</div>
</div>'''
  # New chat's StartComposer: the card's hairline and Enviar are the page's gradient surfaces (the drawing's C is its own)
  return f'''<div class="col" style="gap: 8px">
<div class="card grad-border" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<label class="grow" style="display: flex; min-height: 36px; align-items: center; padding-left: 8px"><textarea rows="1" placeholder="{PLACEHOLDER}" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: var(--fs-body); padding: 0"></textarea></label>
<button type="button" class="btn btn-primary btn-icon" aria-label="Enviar">{ico("send", "ico", "stroke-width: 2.2")}</button>
</div>
<div class="row" style="gap: 6px">{context_chip()}<button type="button" class="chip">Sonnet</button></div>
</div>'''


def desktop_entry():
  # The page's column (.as-body): padding-top 28, 740 wide. Order: hello, the box, the starters, the recents
  main = f'''<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 28px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 28px">
<div class="as-hello">{claudio_il("")}<h1 class="t-h1" style="font-size: var(--fs-title); line-height: 1.15">{GREETING}</h1><p class="as-hello-sub">{SUB}</p></div>
{entry_composer()}
{starters_section(STARTERS)}
{recents(5)}
</div>
</div>'''
  crumb = '<span style="font-weight: var(--fw-regular)">Asistente</span>'
  write('DesktopAsistenteClaudio.html', desktop('Asistente de Claudio', 'assistant', crumb, main, assistant=True))


def prompt_block(mobile=False):
  if mobile:
    inp = '''<span class="k">proyecto</span>   AGN
<span class="k">tipo</span>       tarea
<span class="k">título</span>     Revisar los límites
              de las columnas
<span class="k">prioridad</span>  media
<span class="k">columna</span>    Backlog'''
  else:
    inp = '''<span class="k">proyecto</span>   AGN
<span class="k">tipo</span>       tarea
<span class="k">título</span>     Revisar los límites de las columnas
<span class="k">prioridad</span>  media
<span class="k">columna</span>    Backlog'''
  size = ' btn-lg' if mobile else ' btn-sm'
  # The app's placeholder is longer than a phone's input: the phone shows the short form
  reason = '¿Por qué no? (opcional)' if mobile else '¿Por qué no? (se envía al modelo al denegar)'
  return f'''<div class="permission" role="group" aria-label="Permiso para escribir" aria-live="polite">
<div class="permission-head">{ico("conn", "ico")}<strong>Crear tarea en AGN</strong><span class="fg-2 t-sm">quiere ejecutarse</span></div>
<pre class="permission-input" role="group" aria-label="Lo que quiere ejecutar" tabindex="0">{inp}</pre>
<p class="permission-note">Se crea en el Backlog de AGN, enlazada a este chat. Si deniegas, no se escribe nada.</p>
<div class="permission-actions">
<button type="button" class="btn btn-primary{size}">{ico("check", "ico ico-sm")}Permitir</button>
<button type="button" class="btn btn-danger{size}">{ico("x", "ico ico-sm")}Denegar</button>
<label class="field permission-reason"><input type="text" placeholder="{reason}" aria-label="Motivo para denegar"></label>
</div>
</div>'''


TOOLS = '<span class="badge">Tablero de AGN</span><span class="badge">AGN-12</span>'
REPLY = 'No hay ninguna tarea abierta sobre los límites de las columnas. Voy a crear una en el Backlog de AGN. <b>Necesito tu permiso para escribir.</b>'
GREET_MSG = f'<div class="as-greeting">{MASCOT}<p style="margin: 0">{HELLO_CHAT}</p></div>'


def desktop_chat():
  main = f'''<div class="col grow" style="gap: 0; min-width: 0; min-height: 0">
<div class="row" style="height: 56px; padding: 0 20px 0 12px; border-bottom: 1px solid var(--line); gap: 10px; flex-shrink: 0">
<a href="DesktopChats.html" class="btn btn-ghost btn-icon btn-sm" aria-label="Volver a chats">{ico('left')}</a>
{mark(True)}
<span class="col grow" style="gap: 1px; min-width: 0"><span class="ellipsis" style="font-weight: var(--fw-strong)">{ASK}</span><span class="mono t-xs fg-3">asistente · {PROJECT} · c41e9b · sonnet</span></span>
<span class="badge b-warn">{ico("lock", "ico ico-sm")}necesita tu permiso</span>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Buscar en el chat">{ico('search')}</button>
<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico('more', 'ico', 'stroke-width: 3')}</button>
</div>
<div style="flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; justify-content: center; padding: 24px 32px 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 16px; font-size: var(--fs-body); line-height: 1.65">
{GREET_MSG}
<div style="align-self: flex-end; max-width: 82%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 11px 15px">{ASK}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>2 consultas · 3 s</span>{TOOLS}</div>
<p style="margin: 0">{REPLY}</p>
</div>
</div>
<div style="display: flex; justify-content: center; padding: 12px 32px 0; flex-shrink: 0"><div style="width: 100%; max-width: 740px">{prompt_block()}</div></div>
<div style="display: flex; justify-content: center; padding: 12px 32px 20px; flex-shrink: 0">
<div class="col" style="width: 100%; max-width: 740px; gap: 8px">
<div class="card" style="border-radius: var(--r-xl); padding: 10px; display: flex; align-items: flex-end; gap: 8px">
<label class="grow" style="display: flex; min-height: 36px; align-items: center; padding-left: 8px"><textarea rows="1" placeholder="Responde o escribe otra cosa…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: var(--fs-body); padding: 0"></textarea></label>
<button type="button" class="btn btn-icon" aria-label="Enviar" disabled>{ico("send", "ico", "stroke-width: 2.2")}</button>
</div>
<div class="row" style="gap: 6px"><button type="button" class="chip">Sonnet</button><span class="grow"></span><span class="t-num t-xs fg-3"><span class="mono">↵</span> enviar · <span class="mono">⇧↵</span> salto</span></div>
</div>
</div>
</div>'''
  crumb = '<a href="DesktopAsistenteClaudio.html" class="fg-2">Asistente</a><span class="fg-3">/</span><span class="mono" style="font-weight: var(--fw-regular)">c41e9b</span>'
  write('DesktopAsistenteClaudioChat.html', desktop('Chat del asistente de Claudio', 'assistant', crumb, main, assistant=True, agents=2))


def mobile_entry():
  inner = f'''<header class="m-head"><h1 class="t-h1 grow">Asistente</h1></header>
<div class="m-body" style="gap: 18px; padding-top: 8px">
<div class="as-hello">{claudio_il("il-sm")}<h2 class="t-h1">{GREETING}</h2><p class="as-hello-sub" style="font-size: var(--fs-body)">{SUB}</p></div>
{starters_section((STARTERS[0], STARTERS[1], STARTERS[3]))}
{recents(3)}
</div>
{entry_composer(True)}
{tabbar('more')}'''
  write('MobileAsistenteClaudio.html', mobile('Asistente de Claudio', inner))


def mobile_chat():
  inner = f'''<header class="row" style="flex-shrink: 0; padding: 8px 4px; gap: 2px">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico('left', 'ico ico-lg', 'stroke-width: 2')}</a>
<span class="col grow" style="gap: 2px; min-width: 0"><span style="font-weight: var(--fw-strong); font-size: var(--fs-input); line-height: 1.3">{ASK}</span><span class="t-num row t-xs" style="gap: 6px"><span class="c-warn">necesita tu permiso</span></span></span>
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico('more', 'ico ico-lg', 'stroke-width: 3')}</button>
</header>
<div class="col" style="flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 12px 16px 0; gap: 14px; font-size: var(--fs-section); line-height: 1.6">
{GREET_MSG}
<div style="align-self: flex-end; max-width: 88%; background: var(--bg-3); border: 1px solid var(--line); border-radius: var(--r-xl) var(--r-xl) var(--r-xs) var(--r-xl); padding: 10px 14px">{ASK}</div>
<div class="row t-xs" style="gap: 8px; font-family: var(--mono); color: var(--fg-3)">{ico('check', 'ico ico-sm c-ok', 'stroke-width: 2.4')}<span>2 consultas · 3 s</span></div>
<p style="margin: 0">{REPLY}</p>
</div>
<div style="flex-shrink: 0; padding: 12px 12px 0">{prompt_block(True)}</div>
<div class="col" style="flex-shrink: 0; padding: 10px 12px 28px">
<div class="card row" style="border-radius: var(--r-xl); padding: 4px; gap: 4px; align-items: flex-end">
<label class="grow" style="display: flex; min-height: var(--touch); align-items: center; padding-left: 12px"><textarea rows="1" placeholder="Responde o escribe otra cosa…" aria-label="Mensaje" style="width: 100%; border: 0; outline: 0; resize: none; background: transparent; font-size: var(--fs-input); padding: 0"></textarea></label>
<button type="button" class="btn btn-icon" aria-label="Enviar" disabled style="width: var(--touch); height: var(--touch); border-radius: 50%">{ico("send", "ico ico-lg", "stroke-width: 2.2")}</button>
</div>
</div>'''
  write('MobileAsistenteClaudioChat.html', mobile('Chat del asistente de Claudio', inner))


def mobile_mas():
  # The Más page keeps its list; the assistant is the first row, with Claudio's glyph on the neutral .ai-mark tile
  s = open(os.path.join(OUT, 'MobileMas.html')).read()
  row = (f'<a href="MobileAsistenteClaudio.html" class="cell">{mark()}<span class="grow" style="font-weight: var(--fw-regular)">Asistente</span>'
         f'<span class="t-num t-xs fg-3">pregunta o pide</span>{ico("right", "ico fg-3")}</a>\n\n')
  marker = '<nav aria-label="Secciones" class="card" style="overflow: hidden">\n\n'
  assert marker in s
  write('MobileAsistenteClaudioMas.html', s.replace(marker, marker + row, 1))


if __name__ == '__main__':
  desktop_entry(); desktop_chat(); mobile_entry(); mobile_chat(); mobile_mas()
