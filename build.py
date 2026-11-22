#!/usr/bin/env python3
"""Assemble the single-file NodePulse app from src/ into ../../bitcoin-network-monitor.html

Also writes a clean copy for distribution / the repository at dist/nodepulse.html.
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
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
ASSETS = os.path.join(HERE, 'assets')
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'bitcoin-network-monitor.html'))
DIST = os.path.join(HERE, 'dist', 'nodepulse.html')

CSP_SCRIPT = '/*__CSP_SCRIPT__*/'
CSP_STYLE = '/*__CSP_STYLE__*/'

HTML_ESCAPES = {'<': '\\u003c', '>': '\\u003e', '&': '\\u0026'}


def read(*p):
    with open(os.path.join(*p), encoding='utf-8') as f:
        return f.read()


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


def main():
    self_test_escape()
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
    app = read(SRC, 'app.js').strip()

    for name, blob in (('world', world), ('country', country), ('seed', seed), ('channels', chan), ('l1', l1), ('app', app)):
        if '</script' in blob.lower():
            sys.exit('ERROR: %s contains a closing script tag' % name)

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
    main()
