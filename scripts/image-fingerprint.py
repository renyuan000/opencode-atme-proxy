#!/usr/bin/env python3
import json
import sys

from PIL import Image


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    image = Image.open(sys.argv[1])
    width, height = image.size
    gray = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(gray.getdata())
    bits = 0
    for y in range(8):
        row = y * 9
        for x in range(8):
            bits = (bits << 1) | (1 if pixels[row + x] > pixels[row + x + 1] else 0)
    print(
        json.dumps(
            {"width": width, "height": height, "dhash": f"{bits:016x}"},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
