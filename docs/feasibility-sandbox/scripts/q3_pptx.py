# [media-saver] Q3 (c) — frames/images -> .pptx with python-pptx (sandbox venv only).
# usage: venv/bin/python -I scripts/q3_pptx.py build <manifest.json> <out.pptx> [title]
#        venv/bin/python -I scripts/q3_pptx.py verify <a.pptx> [b.pptx ...]
import json, os, sys, time, resource
from pptx import Presentation
from pptx.util import Emu
from PIL import Image

def build(manifest, out, title=""):
    items = json.load(open(manifest, encoding="utf-8"))
    t0 = time.perf_counter()
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)
    blank = prs.slide_layouts[6]
    for it in items:
        w, h = Image.open(it["jpegPath"]).size
        s = min(prs.slide_width / w, prs.slide_height / h)
        cw, ch = int(w * s), int(h * s)
        slide = prs.slides.add_slide(blank)
        fill = slide.background.fill
        fill.solid()
        from pptx.dml.color import RGBColor
        fill.fore_color.rgb = RGBColor(0, 0, 0)
        slide.shapes.add_picture(it["jpegPath"], (prs.slide_width - cw) // 2, (prs.slide_height - ch) // 2, cw, ch)
    prs.core_properties.title = title
    if os.path.exists(out):
        os.remove(out)
    prs.save(out)
    print(json.dumps({"engine": "python-pptx", "out": out, "slides": len(items),
                      "ms": round((time.perf_counter() - t0) * 1000), "bytes": os.path.getsize(out),
                      "peakRssMB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576)}))

def verify(paths):
    for p in paths:
        try:
            prs = Presentation(p)
            pics = [sh for s in prs.slides for sh in s.shapes if sh.shape_type == 13]
            print(json.dumps({"file": os.path.basename(p), "opens": True, "slides": len(prs.slides),
                              "pictures": len(pics), "slideSizeEMU": [prs.slide_width, prs.slide_height],
                              "title": prs.core_properties.title,
                              "firstPicEMU": [pics[0].left, pics[0].top, pics[0].width, pics[0].height] if pics else None,
                              "firstPicType": pics[0].image.content_type if pics else None}, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001 — report any parse failure
            print(json.dumps({"file": os.path.basename(p), "opens": False, "error": repr(e)}))

if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(*sys.argv[2:])
    else:
        verify(sys.argv[2:])
