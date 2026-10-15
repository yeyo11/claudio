"""Builds the Claudio brand kit's vector masters from the identity board.

The mark is redrawn as geometry (no text, no fonts): an open, chamfered C with 45 degree cuts, a
four-point spark and a prompt block. The wordmark is Inter at weight 700, shaped with HarfBuzz and
converted to outlines, so it renders the same everywhere.

usage: uv run --no-project --with fonttools --with uharfbuzz python -I build.py <inter-var.ttf> <out-dir>
"""

import io
import math
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

BLUE, CYAN, VIOLET = "#246BFD", "#00E5FF", "#A78BFA"
ICE, SLATE, SPACE = "#F4F7FF", "#17233D", "#0B1020"
# The cyan spark disappears on a light page (1.3:1); on light the spark and block take the brand blue.
BLUE_ON_LIGHT_SPARK = BLUE

# Symbol grid: the C spans y 10..110 (100 units) and x 10..96; the block reaches x 109.
C_OUTLINE = [
    ((46, 10), 6), ((74, 10), 3), ((96, 32), 3), ((54, 32), 3), ((32, 54), 4), ((32, 66), 4),
    ((54, 88), 3), ((96, 88), 3), ((74, 110), 3), ((46, 110), 6), ((10, 74), 6), ((10, 46), 6),
]
SPARK_C, SPARK_R, SPARK_PINCH = (62.0, 60.0), 19.0, 6.0
BLOCK = (98.0, 51.5, 11.0, 17.0, 3.0)  # x, y, w, h, rx
SYMBOL_BOX = (10.0, 10.0, 99.0, 100.0)  # x, y, w, h


def fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def rounded_polygon(points: list[tuple[tuple[float, float], float]]) -> str:
    """Each vertex is cut back by its radius along both edges and joined with a quadratic curve."""
    n = len(points)
    parts = []
    for i, ((px, py), r) in enumerate(points):
        (ax, ay), _ = points[i - 1]
        (bx, by), _ = points[(i + 1) % n]
        da, db = math.hypot(ax - px, ay - py), math.hypot(bx - px, by - py)
        p1 = (px + (ax - px) / da * r, py + (ay - py) / da * r)
        p2 = (px + (bx - px) / db * r, py + (by - py) / db * r)
        parts.append(("M" if i == 0 else "L") + f"{fmt(p1[0])} {fmt(p1[1])}")
        parts.append(f"Q{fmt(px)} {fmt(py)} {fmt(p2[0])} {fmt(p2[1])}")
    return "".join(parts) + "Z"


def spark_path() -> str:
    cx, cy = SPARK_C
    r, k = SPARK_R, SPARK_PINCH
    tips = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    ctrl = [(cx + k, cy - k), (cx + k, cy + k), (cx - k, cy + k), (cx - k, cy - k)]
    d = f"M{fmt(tips[0][0])} {fmt(tips[0][1])}"
    for i in range(4):
        c, t = ctrl[i], tips[(i + 1) % 4]
        d += f"Q{fmt(c[0])} {fmt(c[1])} {fmt(t[0])} {fmt(t[1])}"
    return d + "Z"


def gradient(gid: str) -> str:
    # Blue holds the top arm and the spine; violet arrives in the bottom arm, as on the board.
    return (
        f'<linearGradient id="{gid}" x1="0.35" y1="0" x2="0.6" y2="1">'
        f'<stop offset="0" stop-color="{BLUE}"/><stop offset="0.5" stop-color="{BLUE}"/>'
        f'<stop offset="1" stop-color="{VIOLET}"/></linearGradient>'
    )


def mark(c_paint: str, accent: str) -> str:
    x, y, w, h, rx = BLOCK
    return (
        f'<path d="{rounded_polygon(C_OUTLINE)}" fill="{c_paint}"/>'
        f'<path d="{spark_path()}" fill="{accent}"/>'
        f'<rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" rx="{fmt(rx)}" fill="{accent}"/>'
    )


def wordmark(font_path: str, text: str, size: float, tracking_em: float) -> tuple[str, float, float]:
    """Returns (path data with the baseline at y=0 and the first glyph at x=0, advance width, cap height)."""
    var = TTFont(font_path)
    inst = instancer.instantiateVariableFont(var, {"wght": 700, "slnt": 0})
    buf = io.BytesIO()
    inst.save(buf)
    data = buf.getvalue()
    font = TTFont(io.BytesIO(data))
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()

    hb_font = hb.Font(hb.Face(data))
    hb_buf = hb.Buffer()
    hb_buf.add_str(text)
    hb_buf.guess_segment_properties()
    hb.shape(hb_font, hb_buf, {"kern": True, "liga": True})

    scale = size / upem
    track = tracking_em * size
    pen = SVGPathPen(glyphs)
    x = 0.0
    infos, positions = hb_buf.glyph_infos, hb_buf.glyph_positions
    for i, (info, pos) in enumerate(zip(infos, positions)):
        name = order[info.codepoint]
        ox = x + pos.x_offset * scale
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, ox, -pos.y_offset * scale)))
        x += pos.x_advance * scale + (track if i < len(infos) - 1 else 0)
    cap = font["OS/2"].sCapHeight * scale
    return pen.getCommands(), x, cap


def svg(w: float, h: float, body: str, vb: tuple[float, float, float, float] | None = None) -> str:
    vb = vb or (0, 0, w, h)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(w)}" height="{fmt(h)}" '
        f'viewBox="{" ".join(fmt(v) for v in vb)}">{body}</svg>\n'
    )


def main() -> None:
    font_path, out = sys.argv[1], Path(sys.argv[2])
    (out / "logos/svg").mkdir(parents=True, exist_ok=True)
    (out / "icons/svg").mkdir(parents=True, exist_ok=True)

    sx, sy, sw, sh = SYMBOL_BOX
    grad = "claudio-brand"

    # Symbol
    (out / "logos/svg/claudio-symbol.svg").write_text(
        svg(sw * 1.2, sh * 1.2, f"<defs>{gradient(grad)}</defs>{mark(f'url(#{grad})', CYAN)}", SYMBOL_BOX)
    )

    # Horizontal lockups: cap height is 63 % of the symbol, the wordmark starts 21 units after the
    # block, and its caps sit a little above the symbol's centre, as on the board.
    cap_ratio = 0.63
    probe_size = 100.0
    _, _, probe_cap = wordmark(font_path, "Claudio", probe_size, -0.03)
    size = probe_size * (cap_ratio * sh) / probe_cap
    words, width, cap = wordmark(font_path, "Claudio", size, -0.03)
    x0 = BLOCK[0] + BLOCK[2] + 21
    baseline = sy + sh / 2 - 4 + cap / 2
    total_w = x0 + width - sx
    vb = (sx, sy, total_w, sh)
    word = lambda fill: f'<path transform="translate({fmt(x0)} {fmt(baseline)})" d="{words}" fill="{fill}"/>'
    lockups = {
        "claudio-horizontal-dark": (mark(f"url(#{grad})", CYAN), ICE, True),
        "claudio-horizontal-light": (mark(f"url(#{grad})", BLUE_ON_LIGHT_SPARK), SPACE, True),
        "claudio-horizontal-mono-dark": (mark(ICE, ICE), ICE, False),
        "claudio-horizontal-mono-light": (mark(SPACE, SPACE), SPACE, False),
    }
    for name, (m, ink, needs_grad) in lockups.items():
        defs = f"<defs>{gradient(grad)}</defs>" if needs_grad else ""
        (out / f"logos/svg/{name}.svg").write_text(svg(total_w * 1.3, sh * 1.3, defs + m + word(ink), vb))

    # App icon: a 1024 tile with a 48 unit margin and a 22.5 % corner, the mark optically centred
    # (the block makes the mark heavy on the right, so it shifts left by a third of the block).
    tile, margin = 1024, 48
    inner = tile - 2 * margin
    rx = inner * 0.225
    scale = 0.66 * inner / sh
    cx = sx + sw / 2 - BLOCK[2] / 3
    cy = sy + sh / 2
    tx, ty = tile / 2 - cx * scale, tile / 2 - cy * scale
    placed = lambda body: f'<g transform="translate({fmt(tx)} {fmt(ty)}) scale({fmt(scale)})">{body}</g>'
    bg_grad = (
        '<linearGradient id="claudio-tile" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{SLATE}"/><stop offset="0.7" stop-color="{SPACE}"/></linearGradient>'
    )
    tile_rect = lambda fill, stroke: (
        f'<rect x="{margin}" y="{margin}" width="{inner}" height="{inner}" rx="{fmt(rx)}" fill="{fill}"'
        + (f' stroke="{stroke}" stroke-opacity="0.35" stroke-width="6"' if stroke else "")
        + "/>"
    )
    icons = {
        "claudio-app-icon": f"<defs>{gradient(grad)}{bg_grad}</defs>"
        + tile_rect("url(#claudio-tile)", BLUE)
        + placed(mark(f"url(#{grad})", CYAN)),
        "claudio-app-icon-white": tile_rect(SPACE, None) + placed(mark(ICE, ICE)),
        "claudio-app-icon-black": tile_rect(ICE, None) + placed(mark(SPACE, SPACE)),
    }
    for name, body in icons.items():
        (out / f"icons/svg/{name}.svg").write_text(svg(tile, tile, body))

    # Micro icon for 16-32 px: no margin, a tighter corner, a bigger mark, so the spark survives.
    m_scale = 0.78 * tile / sh
    m_tx, m_ty = tile / 2 - cx * m_scale, tile / 2 - cy * m_scale
    micro = (
        f"<defs>{gradient(grad)}</defs>"
        f'<rect width="{tile}" height="{tile}" rx="{fmt(tile * 0.2)}" fill="{SPACE}"/>'
        f'<g transform="translate({fmt(m_tx)} {fmt(m_ty)}) scale({fmt(m_scale)})">{mark(f"url(#{grad})", CYAN)}</g>'
    )
    (out / "icons/svg/claudio-micro.svg").write_text(svg(tile, tile, micro))


if __name__ == "__main__":
    main()
