"""Validate official Pixel Console exports and build a magnified inspection sheet."""
from pathlib import Path
import struct
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

logo = ET.parse(ROOT / "island-hud-logo.svg").getroot()
assert logo.attrib.get("viewBox") == "0 0 1024 1024"
mark = ET.parse(ROOT / "island-hud-mark.svg").getroot()
assert mark.attrib.get("viewBox") == "32 160 960 704"
print("OK SVG  official tile + transparent standalone mark")

for size in SIZES:
    path = ROOT / f"island-hud-logo-{size}.png"
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        image.load()
        assert image.size == (size, size), (path.name, image.size)
        assert image.mode == "RGBA", (path.name, image.mode)
        corners = [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]
        assert all(image.getpixel(point)[3] == 0 for point in corners), path.name
        assert image.getpixel((size // 2, size // 2))[3] == 255, path.name
    print(f"OK PNG {size:4d}  RGBA / transparent corners")

ico = (ROOT / "island-hud-logo.ico").read_bytes()
reserved, kind, count = struct.unpack_from("<HHH", ico, 0)
assert (reserved, kind, count) == (0, 1, len(ICO_SIZES))
for index, expected in enumerate(ICO_SIZES):
    entry = 6 + index * 16
    width = ico[entry] or 256
    height = ico[entry + 1] or 256
    length, offset = struct.unpack_from("<II", ico, entry + 8)
    assert (width, height) == (expected, expected)
    assert ico[offset:offset + 8] == b"\x89PNG\r\n\x1a\n"
    png_width, png_height = struct.unpack_from(">II", ico, offset + 16)
    assert (png_width, png_height) == (expected, expected)
    assert offset + length <= len(ico)
print(f"OK ICO  {count} entries: {', '.join(map(str, ICO_SIZES))}")

# Enlarge with nearest-neighbor so the actual rasterization at each size is visible.
canvas = Image.new("RGB", (1400, 780), "#0B0D12")
draw = ImageDraw.Draw(canvas)
font_dir = Path("C:/Windows/Fonts")
def font(size, bold=False):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    return ImageFont.truetype(str(font_dir / name), size)

draw.text((60, 38), "Island HUD / Pixel Console export inspection", font=font(30, True), fill="#F2F5FA")
draw.text((60, 82), "Nearest-neighbor enlargement exposes the real pixels used at each icon size.", font=font(16), fill="#8B9BB2")

rows = [(126, "#111720", "#DDE8FA", "DARK SURFACE"), (444, "#EAF0F8", "#17233A", "LIGHT SURFACE")]
for y, card, foreground, label in rows:
    draw.rounded_rectangle((48, y, 1352, y + 282), radius=26, fill=card)
    draw.text((76, y + 22), label, font=font(13, True), fill=foreground)
    for column, size in enumerate([16, 24, 32, 48, 64, 96]):
        x = 92 + column * 207
        with Image.open(ROOT / f"island-hud-logo-{size}.png") as source:
            enlarged = source.resize((144, 144), Image.Resampling.NEAREST)
            canvas.paste(enlarged, (x, y + 62), enlarged)
        text = f"{size}px / {144 / size:g}x"
        box = draw.textbbox((0, 0), text, font=font(14))
        draw.text((x + 72 - (box[2] - box[0]) / 2, y + 222), text, font=font(14), fill=foreground)

canvas.save(ROOT / "validation.png")
print("OK validation.png")
print("All official Pixel Console exports passed.")
