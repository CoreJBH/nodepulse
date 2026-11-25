#!/usr/bin/env python3
"""Capture the store screenshots from the built page, at phone size.

The page is the app: `dist/nodepulse.html` is what `build.py` assembles from
`src/`, and what the Android shell loads. Rendering it in a headless Chromium at
390x844 with a device pixel ratio of 2 gives the same 780x1688 canvas the store
listing has used, with the current English-only header (no language button) and
whatever the live endpoints answer at capture time.

Two files are written: the L1 layer as the page opens, and the Lightning layer
after the LIGHTNING tab is pressed. Everything on screen is public network data
(mempool.space, Bitnodes) or the bundled Bitnodes snapshot, which is what the
page itself labels it as; nothing here reads from a wallet, an account or a
device.

Usage:
    python3 tools/make_store_screenshots.py

Needs playwright with Chromium installed, plus the shared libraries under
/workspace/.libroot on LD_LIBRARY_PATH in this environment.
"""

import asyncio
import pathlib
import sys

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = ROOT / "dist" / "nodepulse.html"
OUT = ROOT / "fastlane" / "metadata" / "android" / "en-US" / "images" / "phoneScreenshots"

VIEWPORT = {"width": 390, "height": 844}
DPR = 2
SETTLE_MS = 12000      # the page's own poll/websocket pass, and the hint fade


async def main():
    if not PAGE.exists():
        sys.exit(f"no built page at {PAGE}; run build.py first")
    OUT.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])
        page = await browser.new_page(viewport=VIEWPORT, device_scale_factor=DPR)
        await page.goto(PAGE.as_uri())
        await page.wait_for_timeout(SETTLE_MS)

        await page.screenshot(path=str(OUT / "01-l1-full-node-globe.png"))
        state = await page.evaluate(
            "() => ({layer: document.body.className,"
            " height: document.getElementById('pHeight')?.textContent,"
            " mem: document.getElementById('sMem')?.textContent})"
        )
        print("L1:", state)

        await page.click("#layerLN")
        await page.wait_for_timeout(SETTLE_MS)
        await page.screenshot(path=str(OUT / "02-lightning-channel-graph.png"))
        state = await page.evaluate(
            "() => ({layer: document.body.className,"
            " mem: document.getElementById('sMem')?.textContent,"
            " sub: document.getElementById('subrow')?.textContent})"
        )
        print("LN:", state)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
