"""Builds the installable app (index.html) and the single-file preview (preview.html) from src/app.html."""
import pathlib
root = pathlib.Path(__file__).parent
app = (root / 'src/app.html').read_text()
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f2f3f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f14" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Tally">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)} body{overscroll-behavior-y:none} [hidden]{display:none!important}</style>
<script>window.PWA_MODE = true;</script>
<script src="vendor/supabase-2.117.2.js"></script>
<script src="config.js"></script>
'''
body = app.replace('<div class="app" id="app">', '</head>\n<body>\n<div class="app" id="app">', 1)
(root / 'index.html').write_text(head + body + '\n<script src="sync.js"></script>\n</body>\n</html>\n')
(root / 'sync.js').write_text((root / 'src/sync.js').read_text())
(root / 'preview.html').write_text(app)
print('built')
