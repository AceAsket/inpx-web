"""Reproduce fb2cng's generated assets without installing its development hooks."""
import gzip
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import zipfile

root = pathlib.Path(sys.argv[1])
cache = root.parent
lock = json.loads((pathlib.Path(__file__).resolve().parents[2] / 'android/converter-assets.lock.json').read_text())

def fetch(url, target):
    target = pathlib.Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        subprocess.run(['curl', '-fL', '--tlsv1.2', '--tls-max', '1.2', '--retry', '5', '--retry-all-errors', url, '-o', str(target)], check=True)
    data = target.read_bytes()
    expected = lock[str(target.relative_to(cache))]
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Asset checksum mismatch: ' + str(target))
    return data

def gz(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(data, mtime=0))

dictionary = root / 'content/text/dictionaries'
if len(list(dictionary.glob('*.gz'))) < 90:
    data = fetch('https://mirrors.ibiblio.org/CTAN/language/hyphenation-utf8.zip', cache / 'hyphenation.zip')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if '/patterns/txt/hyph-' in name and name.endswith(('.pat.txt', '.hyp.txt')):
                gz(dictionary / (pathlib.PurePosixPath(name).name + '.gz'), z.read(name))

sentences = root / 'content/text/sentences'
if len(list(sentences.glob('*.gz'))) < 20:
    data = fetch('https://codeload.github.com/neurosnap/sentences/tar.gz/refs/tags/v1.1.2', cache / 'sentences.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for entry in t:
            if '/data/' in entry.name and entry.name.endswith('.json') and entry.isfile():
                gz(sentences / (pathlib.PurePosixPath(entry.name).name + '.gz'), t.extractfile(entry).read())

fonts = ['NotoSerif/' + x for x in ['NotoSerif-Regular', 'NotoSerif-Bold', 'NotoSerif-Italic', 'NotoSerif-BoldItalic']]
fonts += ['NotoSans/' + x for x in ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSans-BoldItalic']]
fonts += ['NotoSansMono/NotoSansMono-Regular', 'NotoSansMono/NotoSansMono-Bold', 'NotoSansMath/NotoSansMath-Regular', 'NotoSansSymbols/NotoSansSymbols-Regular', 'NotoSansSymbols2/NotoSansSymbols2-Regular']
for name in fonts:
    target = root / 'convert/pdf/fonts' / (name.split('/')[-1] + '.ttf.gz')
    if not target.exists():
        data = fetch('https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/' + name + '.ttf', cache / 'fonts' / (name.split('/')[-1] + '.ttf'))
        gz(target, data)

misc = root / 'misc'
misc.mkdir(exist_ok=True)
(misc / 'version.go').write_text('package misc\nfunc GetAppName() string { return "fbc" }\nfunc GetVersion() string { return "1.9.0-android" }\nfunc GetGitHash() string { return "81c612754b65cef23871ba7366aa86451b347367" }\n')
print('fb2cng assets prepared')
