# dice-timer.html から、公開用の index.html（GitHub Pages で開くページ）を作る
# - 本体には <!doctype html> などが無いので、前後に足す（<title>・<meta>・<style> は <head> へ）
# - ホーム画面に追加したときに、アプリのように全画面で開く設定と、アイコン・manifest の読み込みも足す
#   （アイコンは tools/make_icons.py で assets/icons/ に作る）
# - 本体の先頭にある Artifact 用の印（claude:viewport-fit-sides）は、ふつうのページでは要らないので外す
# 使い方: python tools/build_pages.py   （dice-timer フォルダで実行。本体を直したら作り直す）
import os, re

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(here, 'dice-timer.html'), encoding='utf-8').read()

m = re.search(r'</style>', src)
if not m:
    raise SystemExit('</style> が見つからない')
head_part, body_part = src[:m.end()], src[m.end():]
head_part = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\s*', '', head_part)

page = '\n'.join([
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="description" content="ボードゲーム用のサイコロと手番タイマー。画面を押すとサイコロが振れて、手番の時間も計れる">',
    '<meta name="theme-color" content="#000000">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="サイコロタイマー">',
    '<link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png">',
    '<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>',
    head_part.strip(),
    '</head>',
    '<body>',
    body_part.strip(),
    '</body>',
    '</html>',
    ''
])
out = os.path.join(here, 'index.html')
open(out, 'w', encoding='utf-8', newline='\n').write(page)
print('作った:', out, '%d KB' % (len(page.encode('utf-8')) // 1024))
