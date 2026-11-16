"""生成簡單嘅 PWA icon(唔靠外部圖庫,純用 Pillow 畫)。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT_DIR, exist_ok=True)

BG = (11, 95, 207, 255)  # 同 theme-color 一致
FG = (255, 255, 255, 255)


def make_icon(size, path):
    img = Image.new('RGBA', (size, size), BG)
    draw = ImageDraw.Draw(img)

    # 畫一個簡化嘅日曆圖示
    margin = size * 0.16
    top = size * 0.22
    bottom = size * 0.86
    left = margin
    right = size - margin
    draw.rounded_rectangle([left, top, right, bottom], radius=size * 0.06, outline=FG, width=max(2, int(size * 0.035)))
    # 頂部兩個「掛耳」
    ear_w = size * 0.03
    draw.rectangle([left + size * 0.12, top - size * 0.08, left + size * 0.12 + ear_w, top + size * 0.04], fill=FG)
    draw.rectangle([right - size * 0.12 - ear_w, top - size * 0.08, right - size * 0.12, top + size * 0.04], fill=FG)
    # 橫線(日曆header)
    header_bottom = top + size * 0.16
    draw.rectangle([left, top, right, header_bottom], outline=FG, width=max(2, int(size * 0.02)))

    # 文字 "BNO"
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(size * 0.22))
    except Exception:
        font = ImageFont.load_default()
    text = 'BNO'
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = header_bottom + (bottom - header_bottom - th) / 2 - bbox[1]
    draw.text((tx, ty), text, fill=FG, font=font)

    img.save(path)
    print('saved', path, size)


make_icon(192, os.path.join(OUT_DIR, 'icon-192.png'))
make_icon(512, os.path.join(OUT_DIR, 'icon-512.png'))
