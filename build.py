#!/usr/bin/env python3
"""Assemble the single-file NODEPULSE app from src/ into ../../bitcoin-network-monitor.html

Also writes a clean copy for distribution / the repository at dist/nodepulse.html.
The app icon (assets/icon-64.png for the tab, assets/icon-180.png for the
home-screen icon) is inlined as a base64 data URI so the build stays a single
self-contained file with no external requests.
"""
import base64
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
ASSETS = os.path.join(HERE, 'assets')
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'bitcoin-network-monitor.html'))
DIST = os.path.join(HERE, 'dist', 'nodepulse.html')


def read(*p):
    with open(os.path.join(*p), encoding='utf-8') as f:
        return f.read()


def icon_b64(name):
    with open(os.path.join(ASSETS, name), 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def main():
    tpl = read(SRC, 'index.template.html')
    css = read(SRC, 'app.css')
    world = read(SRC, 'data', 'world-data.js').strip()
    country = read(SRC, 'data', 'countries-data.js').strip()
    seed = read(SRC, 'data', 'seed-nodes.js').strip()
    chan = read(SRC, 'data', 'channels-data.js').strip()
    app = read(SRC, 'app.js').strip()

    for name, blob in (('world', world), ('country', country), ('seed', seed), ('channels', chan), ('app', app)):
        if '</script' in blob.lower():
            sys.exit('ERROR: %s contains a closing script tag' % name)

    out = tpl.replace('/*__CSS__*/', css)
    out = out.replace('/*__WORLD__*/', world)
    out = out.replace('/*__COUNTRY__*/', country)
    out = out.replace('/*__SEED__*/', seed)
    out = out.replace('/*__CHANNELS__*/', chan)
    out = out.replace('/*__APP__*/', app)
    out = out.replace('__ICON_FAVICON__', icon_b64('icon-64.png'))
    out = out.replace('__ICON_TOUCH__', icon_b64('icon-180.png'))

    for token in ('__ICON_FAVICON__', '__ICON_TOUCH__'):
        if token in out:
            sys.exit('ERROR: icon token %s was not substituted' % token)

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (OUT, len(out.encode('utf-8'))))

    os.makedirs(os.path.dirname(DIST), exist_ok=True)
    with open(DIST, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (DIST, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
