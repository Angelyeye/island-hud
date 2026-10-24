from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent
CONCEPTS = ("01-island-pulse", "02-horizon", "03-prompt-island", "04-pixel-island")
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)

for concept in CONCEPTS:
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
    print(f"OK {concept}: {len(SIZES)} RGBA PNG exports")

for name, expected in (("preview.png", (1800, 1480)), ("validation.png", (1800, 1050))):
    path = ROOT / name
    with Image.open(path) as image:
        assert image.size == expected, f"Unexpected dimensions: {path}: {image.size}"
        image.verify()
    print(f"OK {name}: {expected[0]}x{expected[1]}")

print("All logo concept exports passed.")
