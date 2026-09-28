"""
tunnelvision's single-load page capture driver (used by `--by-element`).

For each page: load it once, wait, take a full-page screenshot, then run the
element-extraction script in the *same* load, so the element rects line up with
the image exactly and tunnelvision can crop every element out of it.

Runs on the Playwright that shot-scraper already installs. Reads a JSON job from
stdin and writes one JSON line per page to stdout as each page finishes:

    {"index": 0, "ok": true, "tree": [...], "styles": {...}}
    {"index": 1, "ok": false, "error": "..."}

`styles` holds the CSS rules matched to every element (see `RawStyles` in
src/styles.ts), read over CDP from the same load. It's null when CDP isn't
available.
"""

import asyncio
import json
import re
import sys

from playwright.async_api import async_playwright


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


IMPORTANT = re.compile(r"\s*!\s*important\s*$", re.I)
# CDP calls in flight at once while reading matched styles.
CDP_CONCURRENCY = 32


def selectors(tree):
    for node in tree:
        yield node["selector"]
        yield from selectors(node["children"])


def ancestors(selector):
    """Selectors of an element's ancestors, nearest first, ending at <html>."""
    parts = selector.split(" > ")
    out = [" > ".join(parts[:i]) for i in range(len(parts) - 1, 0, -1)]
    return out + ["html"]


def decls(style):
    """The declarations actually written in a CDP style (ranged entries only)."""
    out = []
    for p in style.get("cssProperties", []):
        if "range" not in p or p.get("disabled") or p.get("parsedOk") is False:
            continue
        d = {"name": p["name"], "value": IMPORTANT.sub("", p["value"]), "range": p["range"]}
        if p.get("important"):
            d["important"] = True
        if p.get("longhandProperties"):
            d["longhands"] = [l["name"] for l in p["longhandProperties"]]
        out.append(d)
    return out


async def read_styles(page, tree):
    """Matched rules for every element in `tree`, deduplicated into a rule table."""
    cdp = await page.context.new_cdp_session(page)
    headers = {}
    cdp.on("CSS.styleSheetAdded", lambda e: headers.__setitem__(e["header"]["styleSheetId"], e["header"]))
    await cdp.send("DOM.enable")
    await cdp.send("CSS.enable")
    root = (await cdp.send("DOM.getDocument", {"depth": 0}))["root"]["nodeId"]
    sem = asyncio.Semaphore(CDP_CONCURRENCY)

    async def matched(selector):
        async with sem:
            try:
                node = await cdp.send("DOM.querySelector", {"nodeId": root, "selector": selector})
                if not node.get("nodeId"):
                    return None
                return await cdp.send("CSS.getMatchedStylesForNode", {"nodeId": node["nodeId"]})
            except Exception:
                return None

    sels = list(selectors(tree))
    results = await asyncio.gather(*(matched(s) for s in sels))

    async def owner_attrs(header):
        if not header.get("ownerNode"):
            return {}
        try:
            node = await cdp.send("DOM.describeNode", {"backendNodeId": header["ownerNode"]})
            attrs = node["node"].get("attributes", [])
            return dict(zip(attrs[::2], attrs[1::2]))
        except Exception:
            return {}

    owners = {sid: await owner_attrs(h) for sid, h in list(headers.items())}
    # tunnelvision's own <style> (animations frozen by the stabilize script) isn't the app's CSS.
    ours = {sid for sid, attrs in owners.items() if "data-tunnelvision" in attrs}

    rules, index, used_sheets = [], {}, set()

    def rule_id(rule):
        sheet = rule.get("styleSheetId")
        rng = rule["style"].get("range")
        if not sheet or not rng or sheet in ours:
            return None
        key = (sheet, rng["startLine"], rng["startColumn"])
        if key not in index:
            sel = rule["selectorList"]
            ranges = [s["range"] for s in sel.get("selectors", []) if s.get("range")]
            r = {
                "sheet": sheet,
                "selector": sel["text"],
                "selectorRange": ranges[0] if ranges else None,
                "styleRange": rng,
                "decls": decls(rule["style"]),
            }
            layers = [l["text"] for l in rule.get("layers", []) if l.get("text")]
            if layers:
                r["layers"] = layers
            index[key] = len(rules)
            rules.append(r)
            used_sheets.add(sheet)
        return index[key]

    def inline_id(style, owner):
        key = ("inline", owner)
        if key not in index:
            found = decls(style)
            if not found:
                return None
            for d in found:
                d["range"] = None
            index[key] = len(rules)
            rules.append({"sheet": None, "inline": owner, "selector": "style attribute", "selectorRange": None, "decls": found})
        return index[key]

    def level(matched_rules, inline, owner):
        ids = [rule_id(m["rule"]) for m in matched_rules if m["rule"].get("origin") == "regular"]
        if inline and owner:
            ids.append(inline_id(inline, owner))
        return [i for i in ids if i is not None]

    nodes = {}
    for sel, res in zip(sels, results):
        if not res:
            continue
        up = ancestors(sel)
        nodes[sel] = {
            "rules": level(res.get("matchedCSSRules", []), res.get("inlineStyle"), sel),
            "inherited": [
                level(lvl.get("matchedCSSRules", []), lvl.get("inlineStyle"), up[i] if i < len(up) else None)
                for i, lvl in enumerate(res.get("inherited", []))
            ],
        }

    sheets = []
    for sid in used_sheets:
        h = headers.get(sid, {})
        try:
            text = (await cdp.send("CSS.getStyleSheetText", {"styleSheetId": sid}))["text"]
        except Exception:
            text = ""
        sheets.append({
            "id": sid,
            "sourceURL": h.get("sourceURL", ""),
            "sourceMapURL": h.get("sourceMapURL") or None,
            "startLine": h.get("startLine", 0),
            "devId": owners.get(sid, {}).get("data-vite-dev-id"),
            "text": text,
        })
    await cdp.detach()
    return {"sheets": sheets, "rules": rules, "nodes": nodes}


async def capture(browser, job, index, page_job, sem):
    async with sem:
        context = await browser.new_context(
            viewport=job["viewport"],
            device_scale_factor=job["scaleFactor"],
            storage_state=job.get("authFile") or None,
            # Sites that honour prefers-reduced-motion skip or shorten their
            # animations, so captures settle sooner and more consistently.
            reduced_motion="reduce",
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
            if page_job.get("stabilizeJs"):
                await page.evaluate(page_job["stabilizeJs"])
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
            try:
                styles = await read_styles(page, tree)
            except Exception:
                styles = None
            emit({"index": index, "ok": True, "tree": tree, "styles": styles})
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
