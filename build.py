#!/usr/bin/env python3
"""Assemble the single-file NodePulse app from src/ into ../../bitcoin-network-monitor.html

Also writes a clean copy for distribution / the repository at dist/nodepulse.html.
With --test it writes dist/nodepulse.test.html instead, keeping the window.NODEPULSE hook
that test/headless.js drives the app through; the release build strips that block.
With --check it writes nothing and only compiles the assembled application code with
`node --check`, which is the syntax gate for src/js/ (an individual module is not a
script on its own: the modules share one function scope inside one IIFE).
The app icon (assets/icon-64.png for the tab, assets/icon-180.png for the
home-screen icon) is inlined as a base64 data URI so the build stays a single
self-contained file with no external requests.

Two things happen here that the source files do not carry themselves:

* The UTF-8 embedded datasets get their <, > and & characters written as the
  \\u003c / \\u003e / \\u0026 escapes. A JSON string from an API cannot terminate
  the script element then, whatever a country name, an alias or a client version
  turns out to contain, and the parsed values are unchanged.

* The Content-Security-Policy meta in the template names each inline <script> and
  <style> block by the SHA-256 of the exact text written here, so the page needs no
  'unsafe-inline'. The hashes are computed after every substitution, and the build
  fails if the written policy does not match the blocks it just produced.
"""
import base64
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
ASSETS = os.path.join(HERE, 'assets')
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'bitcoin-network-monitor.html'))
DIST = os.path.join(HERE, 'dist', 'nodepulse.html')
TEST_DIST = os.path.join(HERE, 'dist', 'nodepulse.test.html')

APP_SRC = os.path.join(SRC, 'js')
CHECK_OUT = os.path.join(HERE, '.build', 'app.js')

CSP_SCRIPT = '/*__CSP_SCRIPT__*/'
CSP_STYLE = '/*__CSP_STYLE__*/'

HTML_ESCAPES = {'<': '\\u003c', '>': '\\u003e', '&': '\\u0026'}


def read(*p):
    with open(os.path.join(*p), encoding='utf-8') as f:
        return f.read()


# The test hook (window.NODEPULSE) is delimited in src/js/90-boot.js so that the shipping build
# does not contain it at all: a page with a switch that can read and drive the app's state
# is a page where anything running in it can do the same. --test keeps the block for
# test/headless.js, which cannot check the app without it.
TEST_HOOK_START = '/*__TEST_HOOK__*/'
TEST_HOOK_END = '/*__TEST_HOOK_END__*/'


def strip_test_hook(app):
    a = app.find(TEST_HOOK_START)
    b = app.find(TEST_HOOK_END)
    if a < 0 or b < a:
        sys.exit('ERROR: the test-hook markers are missing from src/js/90-boot.js')
    return app[:a] + app[b + len(TEST_HOOK_END):]


def app_source():
    """The application code, assembled from src/js/ in file-name order.

    Every module is a plain fragment of the same function scope: 00-core.js opens the
    IIFE that 90-boot.js closes, and the numbered names decide the order they are
    written in. The split is by responsibility (core, network, market, L1, graph, store,
    live feeds, painting, globe, view, boot) and the page still receives one script
    block, so the Content-Security-Policy names one hash for it.
    """
    parts = sorted(glob.glob(os.path.join(APP_SRC, '*.js')))
    if not parts:
        sys.exit('ERROR: no application modules under src/js/')
    out = []
    for p in parts:
        text = read(p).strip()
        if not text:
            sys.exit('ERROR: %s is empty' % p)
        out.append(text)
    return '\n\n'.join(out)


def icon_b64(name):
    with open(os.path.join(ASSETS, name), 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def escape_literals(text):
    """Escape <, > and & inside the JS/JSON string literals of an embedded dataset.

    Only inside a quoted literal is a backslash escape valid, so the walk follows
    quotes (including escapes) and steps over comments. Code outside a string is
    copied untouched.
    """
    out = []
    quote = None
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if quote is not None:
            if c == '\\':
                out.append(text[i:i + 2])
                i += 2
                continue
            if c == quote:
                quote = None
                out.append(c)
                i += 1
                continue
            out.append(HTML_ESCAPES.get(c, c))
            i += 1
            continue
        if c == '"' or c == "'":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j + 2])
            i = j + 2
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j])
            i = j
            continue
        out.append(c)
        i += 1
    if quote is not None:
        sys.exit('ERROR: unterminated string literal in an embedded dataset')
    return ''.join(out)


def self_test_escape():
    """One known string: only what sits inside a literal may change."""
    src = 'var X = {"a":"<b>&","c":\'x<y\'}; /* <c> -> keep */\n'
    want = 'var X = {"a":"\\u003cb\\u003e\\u0026","c":\'x\\u003cy\'}; /* <c> -> keep */\n'
    got = escape_literals(src)
    if got != want:
        sys.exit('ERROR: the literal-escape step is broken:\n  got  %r\n  want %r' % (got, want))


def dataset_payload(text):
    """The JSON body of a data file (the part after `var NAME = `)."""
    decl = re.search(r'\bvar\s+[A-Za-z_$][\w$]*\s*=', text)
    if not decl:
        return None
    body = text[decl.end():]
    a, b = body.find('{'), body.rfind('}')
    if a < 0 or b < a:
        return None
    return body[a:b + 1]


def same_values(original, escaped):
    """True when both sides parse to the same JSON value, None when not comparable."""
    body, body_escaped = dataset_payload(original), dataset_payload(escaped)
    if body is None or body_escaped is None:
        return None
    try:
        return json.loads(body) == json.loads(body_escaped)
    except ValueError:
        return None


def csp_hash(text):
    digest = hashlib.sha256(text.encode('utf-8')).digest()
    return "'sha256-" + base64.b64encode(digest).decode('ascii') + "'"


def apply_csp(html):
    """Name every inline script and style block by its hash and check the result."""
    scripts = re.findall(r'<script>([\s\S]*?)</script>', html)
    styles = re.findall(r'<style>([\s\S]*?)</style>', html)
    if not scripts:
        sys.exit('ERROR: no inline script block found')
    if not styles:
        sys.exit('ERROR: no inline style block found')
    script_hashes = [csp_hash(s) for s in scripts]
    style_hashes = [csp_hash(s) for s in styles]
    html = html.replace(CSP_SCRIPT, ' '.join(script_hashes))
    html = html.replace(CSP_STYLE, ' '.join(style_hashes))
    for token in (CSP_SCRIPT, CSP_STYLE):
        if token in html:
            sys.exit('ERROR: CSP token %s was not substituted' % token)

    meta = re.search(r'http-equiv="Content-Security-Policy" content="([^"]*)"', html)
    if not meta:
        sys.exit('ERROR: no Content-Security-Policy meta in the build')
    policy = meta.group(1)
    if "'unsafe-inline'" in policy:
        sys.exit('ERROR: the policy still allows inline script/style')
    for h in script_hashes + style_hashes:
        if policy.count(h) != 1:
            sys.exit('ERROR: %s is not named exactly once in the policy' % h)
    return html, script_hashes, style_hashes


def main(argv):
    self_test_escape()
    if '--check' in argv[1:]:
        app = app_source()
        os.makedirs(os.path.dirname(CHECK_OUT), exist_ok=True)
        with open(CHECK_OUT, 'w', encoding='utf-8') as f:
            f.write(app)
        node = shutil.which('node')
        if not node:
            sys.exit('ERROR: node is needed for --check (it compiles the assembled app)')
        done = subprocess.run([node, '--check', CHECK_OUT])
        if done.returncode != 0:
            sys.exit('ERROR: the assembled application code does not parse')
        print('checked %s (%d bytes of application code)' % (CHECK_OUT, len(app.encode('utf-8'))))
        return
    test_build = '--test' in argv[1:]
    tpl = read(SRC, 'index.template.html')
    css = read(SRC, 'app.css')
    raw = {
        'world': read(SRC, 'data', 'world-data.js').strip(),
        'country': read(SRC, 'data', 'countries-data.js').strip(),
        'seed': read(SRC, 'data', 'seed-nodes.js').strip(),
        'channels': read(SRC, 'data', 'channels-data.js').strip(),
        'l1': read(SRC, 'data', 'l1-data.js').strip(),
    }
    embedded = {k: escape_literals(v) for k, v in raw.items()}
    compared = 0
    for k, v in raw.items():
        same = same_values(v, embedded[k])
        if same is False:
            sys.exit('ERROR: escaping changed the parsed value of %s' % k)
        if same is True:
            compared += 1
    world, country, seed, chan, l1 = (embedded[k] for k in ('world', 'country', 'seed', 'channels', 'l1'))
    app = app_source()
    if not test_build:
        app = strip_test_hook(app)

    # The stylesheet is written inside <style>…</style> and every data blob and the app
    # inside <script>…</script>. A literal closing tag in any of them would end that
    # element early and let the rest of the text be parsed as markup (the CSP hash would
    # then name a block that no longer matches what the browser runs), so both are checked.
    for name, blob in (('css', css), ('world', world), ('country', country), ('seed', seed), ('channels', chan), ('l1', l1), ('app', app)):
        low = blob.lower()
        if '</script' in low:
            sys.exit('ERROR: %s contains a closing script tag' % name)
        if '</style' in low:
            sys.exit('ERROR: %s contains a closing style tag' % name)

    out = tpl.replace('/*__CSS__*/', css)
    out = out.replace('/*__WORLD__*/', world)
    out = out.replace('/*__COUNTRY__*/', country)
    out = out.replace('/*__SEED__*/', seed)
    out = out.replace('/*__CHANNELS__*/', chan)
    out = out.replace('/*__L1__*/', l1)
    out = out.replace('/*__APP__*/', app)
    out = out.replace('__ICON_FAVICON__', icon_b64('icon-64.png'))
    out = out.replace('__ICON_TOUCH__', icon_b64('icon-180.png'))

    for token in ('__ICON_FAVICON__', '__ICON_TOUCH__'):
        if token in out:
            sys.exit('ERROR: icon token %s was not substituted' % token)

    out, script_hashes, style_hashes = apply_csp(out)

    # The hook is either there on purpose (--test) or not there at all.
    if test_build:
        if 'window.NODEPULSE = {' not in out:
            sys.exit('ERROR: a test build must carry the NODEPULSE hook')
        os.makedirs(os.path.dirname(TEST_DIST), exist_ok=True)
        with open(TEST_DIST, 'w', encoding='utf-8') as f:
            f.write(out)
        print('wrote %s (%d bytes, test hook kept)' % (TEST_DIST, len(out.encode('utf-8'))))
        print('csp: %d script hash(es), %d style hash(es), no unsafe-inline'
              % (len(script_hashes), len(style_hashes)))
        print('embedded data: escaped, %d/%d datasets parsed to the same values'
              % (compared, len(raw)))
        return
    if 'window.NODEPULSE = {' in out or TEST_HOOK_START in out:
        sys.exit('ERROR: a release build still carries the test hook')

    try:
        with open(OUT, 'w', encoding='utf-8') as f:
            f.write(out)
        print('wrote %s (%d bytes)' % (OUT, len(out.encode('utf-8'))))
    except OSError as e:
        print('skipped the workspace copy at %s (%s)' % (OUT, e))

    os.makedirs(os.path.dirname(DIST), exist_ok=True)
    with open(DIST, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (DIST, len(out.encode('utf-8'))))
    print('csp: %d script hash(es), %d style hash(es), no unsafe-inline'
          % (len(script_hashes), len(style_hashes)))
    print('embedded data: escaped, %d/%d datasets parsed to the same values'
          % (compared, len(raw)))


if __name__ == '__main__':
    main(sys.argv)
