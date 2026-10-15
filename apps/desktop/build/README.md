# Desktop build resources

Static assets for the Linux desktop app. This is electron-builder's default `buildResources`
directory, so nothing here needs to be referenced explicitly.

| Path | What it is |
| --- | --- |
| `icon.svg` | Master icon: `claudio-app-icon.svg` from the brand kit (`docs/design-system/claudio-brand-kit/`), 1024 viewBox with a 48 px margin. |
| `icon.png` | 512x512 rasterization of the master. |
| `icons/<size>x<size>.png` | Linux icon set: 16, 32, 48, 64, 128, 256, 512. 16 to 48 come from the kit's micro icon (`claudio-micro.svg`, a bigger mark with no margin, so the spark survives); `apps/web/public/favicon.svg` is that one too. |
| `linux/claudio.desktop` | Desktop entry template (`Icon=claudio`, `StartupWMClass=Claudio`). |
| `linux/io.github.yeyo11.claudio.metainfo.xml` | AppStream metadata. App id: `io.github.yeyo11.claudio`. |

## Regenerating the PNGs

The brand kit is the source of truth: its `source/build.py` draws the SVGs and `source/render.py`
rasterizes them (see the kit's README). Rebuild there, then copy `icons/png/claudio-512.png` to
`icon.png` and `icons/png/claudio-<size>.png` to `icons/<size>x<size>.png`.
