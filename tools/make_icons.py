# アプリのアイコン一式を、元の正方形の絵から作る（ChatGPT で描いた「白い線のストップウォッチ＋サイコロの5の目」黒地）
# - apple-touch-icon.png（180）… iPhone のホーム画面
# - icon-192.png・icon-512.png … Android のホーム画面など
# - icon-maskable-512.png … Android の丸い切り抜き用。絵を8割に縮め、まわりは背景の色でのばす（上のつまみが欠けないように）
# - favicon-32.png … ブラウザのタブ
# 元の絵の付帯情報（作成ツールの記録など）は書き出さない。最後に PNG の中身の塊を並べて確かめる
# 使い方: python tools/make_icons.py _素材/icon-original.png   （dice-timer フォルダで実行）
import os, sys, struct
from PIL import Image

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open(sys.argv[1]).convert('RGB')
if src.width != src.height:
    raise SystemExit('正方形の絵にしてください')
out_dir = os.path.join(here, 'assets', 'icons')
os.makedirs(out_dir, exist_ok=True)

def clean(im):
    # 付帯情報を持たない新しい画像に写す
    out = Image.new('RGB', im.size)
    out.paste(im)
    out.info = {}
    return out

def save(im, name):
    p = os.path.join(out_dir, name)
    clean(im).save(p, optimize=True)
    return p

made = []
for name, size in [('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512), ('favicon-32.png', 32)]:
    made.append(save(src.resize((size, size), Image.LANCZOS), name))

# 丸い切り抜き用：背景の色はふちの画素の中央値（黒地）。8割に縮めた絵を真ん中に置く
w = src.width
border = [src.getpixel((x, y)) for x in range(0, w, 7) for y in (0, w - 1)] + \
         [src.getpixel((x, y)) for y in range(0, w, 7) for x in (0, w - 1)]
bg = tuple(sorted(c[k] for c in border)[len(border) // 2] for k in range(3))
spread = max(max(abs(c[k] - bg[k]) for k in range(3)) for c in border)
inner = 410
canvas = Image.new('RGB', (512, 512), bg)
pad = (512 - inner) // 2
canvas.paste(src.resize((inner, inner), Image.LANCZOS), (pad, pad))
made.append(save(canvas, 'icon-maskable-512.png'))
print('背景の色', bg, 'ふちのばらつき', spread)

def chunk_types(p):
    with open(p, 'rb') as f:
        data = f.read()
    i, types = 8, []
    while i < len(data):
        n = struct.unpack('>I', data[i:i + 4])[0]
        types.append(data[i + 4:i + 8].decode('latin-1'))
        i += 12 + n
    return types

for p in made:
    t = chunk_types(p)
    extra = [c for c in t if c not in ('IHDR', 'IDAT', 'IEND')]
    print(os.path.basename(p), Image.open(p).size, '%d KB' % max(1, os.path.getsize(p) // 1024),
          '付帯情報なし' if not extra else '付帯情報あり: ' + ','.join(extra))
