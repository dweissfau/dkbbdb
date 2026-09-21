# Zip dkbbdb/extension for the Chrome Web Store → store/dkbbdb-extension-<version>.zip (+ the 128 px store icon).
#   python scripts/package-extension.py
import json, os, shutil, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ext, out = os.path.join(ROOT, "extension"), os.path.join(ROOT, "store")
os.makedirs(out, exist_ok=True)
version = json.load(open(os.path.join(ext, "manifest.json"), encoding="utf-8"))["version"]
path = os.path.join(out, f"dkbbdb-extension-{version}.zip")
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    for folder, _, files in os.walk(ext):
        for f in sorted(files):
            full = os.path.join(folder, f)
            z.write(full, os.path.relpath(full, ext).replace(os.sep, "/"))
shutil.copyfile(os.path.join(ext, "icons", "icon128.png"), os.path.join(out, "icon-128.png"))
print(path, os.path.getsize(path), "bytes:", ", ".join(zipfile.ZipFile(path).namelist()))
