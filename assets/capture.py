"""
tunnelvision's single-load page capture driver (used by `--by-element`).

For each page: load it once, wait, take a full-page screenshot, then run the
element-extraction script in the *same* load, so the element rects line up with
the image exactly and tunnelvision can crop every element out of it.

Runs on the Playwright that shot-scraper already installs. Reads a JSON job from
stdin and writes one JSON line per page to stdout as each page finishes:

    {"index": 0, "ok": true, "tree": [...]}
    {"index": 1, "ok": false, "error": "..."}
"""

import asyncio
import json
import sys

from playwright.async_api import async_playwright


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def capture(browser, job, index, page_job, sem):
    async with sem:
        context = await browser.new_context(
            viewport=job["viewport"],
            device_scale_factor=job["scaleFactor"],
            storage_state=job.get("authFile") or None,
        )
        try:
            page = await context.new_page()
            await page.goto(page_job["url"])
            # Let hydration scripts finish loading. Components that hydrate
            # after the stabilize scroll pass never see their scroll-triggered
            # reveals fire. Capped, since some pages never go idle (polling).
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            if page_job.get("wait"):
                await page.wait_for_timeout(page_job["wait"])
            # Fire scroll-triggered reveals and freeze CSS animations (same
            # ordering as shot-scraper: after `wait`, before `waitFor`).
            if job.get("stabilizeJs"):
                await page.evaluate(job["stabilizeJs"])
            if page_job.get("waitFor"):
                await page.wait_for_function(page_job["waitFor"])
            # Chromium's first full-page capture can permanently nudge text
            # layout (e.g. a heading 28px -> 27px), so the painted image no
            # longer matches rects measured beforehand. Take a throwaway shot
            # to settle the layout, capture for real, then measure what was
            # actually painted.
            await page.screenshot(full_page=True)
            await page.screenshot(path=page_job["output"], full_page=True)
            tree = await page.evaluate(job["extractJs"])
            emit({"index": index, "ok": True, "tree": tree})
        except Exception as err:  # report and carry on with the other pages
            emit({"index": index, "ok": False, "error": str(err).splitlines()[0]})
        finally:
            await context.close()


async def main():
    job = json.load(sys.stdin)
    sem = asyncio.Semaphore(max(1, int(job.get("concurrency", 4))))
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            await asyncio.gather(
                *(capture(browser, job, i, pj, sem) for i, pj in enumerate(job["pages"]))
            )
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
