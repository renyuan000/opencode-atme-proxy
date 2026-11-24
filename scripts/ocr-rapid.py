#!/usr/bin/env python3
import json
import sys

from rapidocr_onnxruntime import RapidOCR


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    engine = RapidOCR()
    result, _ = engine(sys.argv[1])
    if not result:
        print(json.dumps({"text": "", "confidence": 0}, ensure_ascii=False))
        return 0
    texts = []
    scores = []
    for item in result:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        text = str(item[1]).strip()
        if not text:
            continue
        texts.append(text)
        try:
            scores.append(float(item[2]))
        except (TypeError, ValueError):
            pass
    confidence = sum(scores) / len(scores) if scores else 0
    print(json.dumps({"text": "\n".join(texts), "confidence": confidence}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
