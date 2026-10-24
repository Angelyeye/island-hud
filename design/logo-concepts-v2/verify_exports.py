from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parent
CONCEPTS = ("05-pixel-pulse", "06-pixel-console", "07-prompt-signal", "08-prompt-stack")
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)

for concept in CONCEPTS:
    source = ROOT / concept / "icon.svg"
    svg = ET.parse(source).getroot()
    assert svg.attrib.get("viewBox") == "0 0 1024 1024", f"Unexpected SVG viewBox: {source}"
    for size in SIZES:
        path = ROOT / concept / f"icon-{size}.png"
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
            assert image.size == (size, size), f"Unexpected dimensions: {path}: {image.size}"
            assert image.mode == "RGBA", f"Expected RGBA: {path}: {image.mode}"
            alpha = image.getchannel("A")
            assert alpha.getextrema()[0] == 0, f"Missing transparent outer corners: {path}"
            assert alpha.getextrema()[1] == 255, f"Missing opaque pixels: {path}"
    print(f"OK {concept}: valid SVG + {len(SIZES)} RGBA PNG exports")

for name, expected in (("preview.png", (1800, 1480)), ("validation.png", (1800, 1050))):
    path = ROOT / name
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        assert image.size == expected, f"Unexpected dimensions: {path}: {image.size}"
    print(f"OK {name}: {expected[0]}x{expected[1]}")

print("All blue pixel logo exports passed.")
