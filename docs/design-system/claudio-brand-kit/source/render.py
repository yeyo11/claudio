"""Rasterizes an SVG to a transparent PNG at an exact pixel size with headless Chrome.

usage: python3 -I render.py <in.svg> <out.png> <width> <height> [background]
"""

import subprocess
import sys
import tempfile
from pathlib import Path

src, dst, w, h = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), int(sys.argv[3]), int(sys.argv[4])
bg = sys.argv[5] if len(sys.argv) > 5 else "transparent"
with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp) / "page.html"
    page.write_text(
        f'<!doctype html><html><body style="margin:0;background:{bg}">'
        f'<img src="file://{src}" style="display:block;width:{w}px;height:{h}px"></body></html>'
    )
    subprocess.run(
        [
            "google-chrome", "--headless", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={tmp}/profile",
            "--force-device-scale-factor=1", "--default-background-color=00000000", "--allow-file-access-from-files",
            f"--window-size={w},{h}", f"--screenshot={dst}", f"file://{page}",
        ],
        check=True, capture_output=True,
    )
