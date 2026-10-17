# The person's own terminal (docs/plans/terminal.md, §4, task t6): the project's terminals page on a desktop
# (DesktopTerminal) and the full-screen terminal on a phone with its key bar (MobileTerminal).
# Runs on its own; imports common.py. The shell is not an agent working: no gradient, no energy border, no --live.
from common import *

P['term'] = 'm4 17 6-6-6-6M12 19h8'
PROJECT = 'claude-wrapper'
PATH = '~/proyectos/claude-wrapper'


def c(n, text, bold=False):
  w = ' style="font-weight: var(--fw-strong)"' if bold else ''
  return f'<span style="color: var(--term-ansi-{n})"{w}>{text}</span>'


def dim(text):
  return f'<span style="color: var(--term-ansi-8)">{text}</span>'


def prompt(cmd='', cursor=False):
  cur = '<span class="term-cursor"></span>' if cursor else ''
  return f'{c(2, "yeyo@equipo", True)}:{c(4, "~/proyectos/claude-wrapper", True)}{c(7, "$")} {cmd}{cur}'


def status(kind, word, icon):
  return f'<span class="term-status {kind}">{ico(icon, "ico ico-sm", "stroke-width: 2.4")}{word}</span>'


OK = status('ok', 'Conectado', 'check')
WARN = status('warn', 'Reconectando', 'warn')
DONE = status('neutral', 'Terminó (0)', 'check')
FAIL = status('bad', 'Terminó con 1', 'x')
IDLE = status('warn', 'Cerrado por inactividad', 'warn')

SHELL = '\n'.join([
  prompt('git status -sb'),
  f'## {c(2, "feat/terminal")}...{c(1, "origin/feat/terminal")} [{c(3, "adelante 2")}]',
  f' {c(3, "M")} packages/ui/src/styles/tokens.css',
  f' {c(3, "M")} docs/design-system.md',
  f'{c(1, "??")} docs/design-system/reference/DesktopTerminal.html',
  prompt('pnpm --filter @claudio/ui test'),
  f'{dim("✔")} {c(7, "dark: every ANSI colour reads on the terminal background")}',
  f'{dim("✔")} {c(7, "light: every ANSI colour reads on the terminal background")}',
  f'{c(2, "ℹ tests 6")}  {c(2, "pass 6")}  {c(7, "fail 0")}',
  prompt('ls --color', cursor=True),
])


def tab(name, st, on=False):
  return f'<button type="button" class="term-tab{" on" if on else ""}">{ico("term", "ico ico-sm")}{name}{st}<span class="x">{ico("x", "ico ico-sm")}</span></button>'


def head(extra=''):
  return (f'<div class="term-head"><span class="term-title ellipsis grow">{PATH}</span>{OK}{extra}'
          f'<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones">{ico("more", "ico", "stroke-width: 3")}</button></div>')


def desktop_terminal():
  search = (f'<label class="field term-search" style="height: var(--control-h-sm)">{ico("search", "ico ico-sm")}'
            '<input placeholder="Buscar" aria-label="Buscar en la terminal"><span class="kbd">Ctrl⇧F</span></label>')
  main = f'''<main class="col" style="flex: 1 1 auto; min-height: 0; padding: 28px 32px; gap: 18px; overflow: hidden">
<div class="row" style="gap: 12px">
<div class="col grow" style="gap: 4px"><h1 style="margin: 0; font-size: var(--fs-title); font-weight: var(--fw-strong)">Terminales</h1>
<span class="t-sm fg-2">Tu propia terminal en {PROJECT}. Corre como tu usuario y solo la abres tú.</span></div>
<div class="row" style="gap: 0"><button type="button" class="btn btn-primary" style="border-radius: var(--r) 0 0 var(--r)">{ico("plus")}Nueva terminal</button>
<button type="button" class="btn btn-primary btn-icon" aria-label="Elegir dónde abrirla" style="border-radius: 0 var(--r) var(--r) 0; width: 30px; margin-left: 1px">{ico("down", "ico ico-sm")}</button></div>
</div>
<div class="col grow" style="min-height: 0; gap: 0">
<div class="term-tabs" role="tablist" aria-label="Terminales abiertas">
{tab("web", OK, True)}{tab("api", WARN)}{tab("release", DONE)}{tab("pruebas", FAIL)}{tab("antigua", IDLE)}
</div>
<section class="term grow" aria-label="Terminal en {PATH}" style="border-top-left-radius: 0">
{head(search)}
<div class="term-screen" role="log">{SHELL}</div>
</section>
</div>
<p class="term-note" style="margin: 0">{ico("warn", "ico ico-sm")}<span>Sin autenticación solo funciona en este equipo. Desde otro dispositivo hace falta el túnel y un token.</span></p>
</main>'''
  write('DesktopTerminal.html', desktop('Terminales', 'projects', pcrumb(PROJECT, ('Terminales', '#')), main))


KEYS = ['Esc', 'Tab', '⇧Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→', '|', '~', '/', '-', '^C', '^D', '^L', '^R']


def mobile_terminal():
  keys = ''.join(f'<button type="button" class="term-key{" on" if k == "Ctrl" else ""}">{k}</button>' for k in KEYS)
  inner = f'''<header class="row" style="flex-shrink: 0; height: 52px; padding: 0 8px; gap: 6px; border-bottom: 1px solid var(--line); background: var(--bg)">
<a href="MobileChats.html" class="btn btn-ghost btn-icon btn-lg" aria-label="Volver">{ico("left", "ico ico-lg")}</a>
<span class="t-num grow ellipsis" style="font-size: var(--fs-small)">claude-wrapper</span>
{OK}
<button type="button" class="btn btn-ghost btn-icon btn-lg" aria-label="Más acciones">{ico("more", "ico ico-lg", "stroke-width: 3")}</button>
</header>
<section class="term grow" aria-label="Terminal en {PATH}" style="margin: 8px; border-radius: var(--r-lg)">
<div class="term-screen" role="log">{SHELL.replace("pnpm --filter @claudio/ui test", "pnpm test").replace("docs/design-system/reference/DesktopTerminal.html", "docs/…/DesktopTerminal.html").replace("packages/ui/src/styles/tokens.css", "packages/ui/…/tokens.css").replace("dark: every ANSI colour reads on the terminal background", "dark: ANSI colours read").replace("light: every ANSI colour reads on the terminal background", "light: ANSI colours read").replace("~/proyectos/claude-wrapper", "~/claude-wrapper").replace("adelante 2", "+2")}</div>
</section>
<div class="term-keys" role="toolbar" aria-label="Teclas">{keys}</div>'''
  write('MobileTerminal.html', mobile('Terminal', inner))


if __name__ == '__main__':
  desktop_terminal(); mobile_terminal()
