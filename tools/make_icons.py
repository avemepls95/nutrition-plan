"""Рисует иконки приложения в docs/icons из шрифта docs/fonts.

Запуск: python tools/make_icons.py
Нужны Pillow, fonttools и brotli (pip install pillow fonttools brotli).
"""
import io
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "docs" / "fonts" / "sofia-sans-xcond-cyrillic.woff2"
OUT = ROOT / "docs" / "icons"

YELLOW = (255, 216, 74)
BLACK = (17, 18, 20)
MASTER = 1024


def heavy_font():
    """PIL не читает woff2, поэтому шрифт фиксируется на весе 900 и отдаётся как TTF."""
    font = TTFont(FONT)
    instantiateVariableFont(font, {"wght": 900}, inplace=True)
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def fit(data, text, width):
    """Подбирает кегль, при котором текст занимает заданную ширину."""
    size = 100
    font = ImageFont.truetype(io.BytesIO(data), size)
    box = font.getbbox(text)
    size = int(size * width / (box[2] - box[0]))
    return ImageFont.truetype(io.BytesIO(data), size)


def draw_tag(data, scale):
    """Жёлтый ценник: крупное «ПЛАН» и чёрная полоса «ПИТАНИЯ» внизу.
    scale < 1 оставляет поля для маскируемой иконки Android.
    """
    img = Image.new("RGB", (MASTER, MASTER), YELLOW)
    d = ImageDraw.Draw(img)
    inner = MASTER * scale
    left = (MASTER - inner) / 2

    band_h = inner * 0.24
    band_top = left + inner - band_h
    d.rectangle([0, band_top, MASTER, MASTER], fill=BLACK)

    big = fit(data, "ПЛАН", inner * 0.80)
    box = big.getbbox("ПЛАН")
    text_h = box[3] - box[1]
    x = (MASTER - (box[2] - box[0])) / 2 - box[0]
    y = left + (band_top - left - text_h) / 2 - box[1]
    d.text((x, y), "ПЛАН", font=big, fill=BLACK)

    small = fit(data, "ПИТАНИЯ", inner * 0.52)
    box = small.getbbox("ПИТАНИЯ")
    x = (MASTER - (box[2] - box[0])) / 2 - box[0]
    y = band_top + (band_h - (box[3] - box[1])) / 2 - box[1]
    d.text((x, y), "ПИТАНИЯ", font=small, fill=YELLOW)
    return img


def main():
    OUT.mkdir(exist_ok=True)
    data = heavy_font()
    plain = draw_tag(data, 0.86)
    maskable = draw_tag(data, 0.68)
    for name, img, size in (
        ("apple-touch-icon.png", plain, 180),
        ("icon-192.png", plain, 192),
        ("icon-512.png", plain, 512),
        ("icon-maskable-512.png", maskable, 512),
    ):
        img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
        print("Записано:", OUT / name)


if __name__ == "__main__":
    main()
