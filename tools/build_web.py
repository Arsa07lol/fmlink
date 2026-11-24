"""Builds web/index.html (a full document for opening the site from the laptop or GitHub Pages)
from web/site.html (the page body used for the claude.ai artifact, which adds its own skeleton).
Run from projects/fmlink:  python tools/build_web.py
Then serve:                python -m http.server 8765   ->  http://localhost:8765/web/
(The microphone only works on http://localhost or https, not when index.html is opened as a file.)"""
import pathlib

web = pathlib.Path(__file__).resolve().parent.parent / "web"
src = (web / "site.html").read_text(encoding="utf-8")
cut = src.index("</style>") + len("</style>")
head, body = src[:cut], src[cut:]
html = ('<!doctype html>\n<html lang="id">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        + head + "\n</head>\n<body>" + body + "\n</body>\n</html>\n")
(web / "index.html").write_text(html, encoding="utf-8")
print("wrote", web / "index.html", len(html), "bytes")
