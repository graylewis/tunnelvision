"""
tunnelvision's single-load page capture driver (used by per-element captures).

For each page: load it once, wait, take a full-page screenshot, then run the
element-extraction script in the *same* load, so the element rects line up with
the image exactly and tunnelvision can crop every element out of it.

Runs on the Playwright that shot-scraper already installs. The first line on
stdin is a JSON job; after that the driver and tunnelvision talk in JSON lines
while each page is still open, so tunnelvision can decide from what's already
been captured how much more of the page it needs:

    out {"index": 0, "event": "redirect", "url": "..."}       landed on another page; done
    out {"index": 0, "event": "fingerprint", "fingerprint": "..."}
     in {"index": 0, "carry": true}                              (cheat mode only) reuse it; done
    out {"index": 0, "event": "extracted", "tree": [...], "changed": [...]}
     in {"index": 0, "query": [...selectors] | "all"}
    out {"index": 0, "event": "done", "styles": {...}}
    out {"index": 1, "event": "error", "error": "..."}

`fingerprint` is the page's render fingerprint (see src/fingerprint.ts).
`changed` lists the elements a changed style rule's selector matches
(`job.changedSelectors`). `styles` holds the CSS rules matched to the queried
elements (see `RawStyles` in src/styles.ts), read over CDP from the same load;
it's null when CDP isn't available.

With `job.mode == "fingerprint"`, each page stops after its fingerprint, which
then also carries the normalized DOM lines and the resources it hashed.
"""

import asyncio
import hashlib
import json
import re
import sys
from urllib.parse import urlsplit, urlunsplit

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


def wanted_leaves(tree, want):
    """Wanted elements with no wanted descendant (every leaf when `want` is None)."""
    out = []

    def visit(node):
        below = False
        for child in node["children"]:
            below = visit(child) or below
        mine = want is None or node["selector"] in want
        if mine and not below:
            out.append(node["selector"])
        return mine or below

    for node in tree:
        visit(node)
    return out


async def read_styles(page, tree, want=None):
    """
    Matched rules for the elements of `tree` in `want` (all of them when None),
    deduplicated into a rule table.

    Only the wanted elements furthest down are queried: each answer already
    carries the matched rules of every ancestor (`inherited`, nearest first),
    so an ancestor's own answer is read off that chain. Wanted elements no
    answer covers are queried directly.
    """
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

    sels = [s for s in selectors(tree) if want is None or s in want]
    in_tree = set(sels)
    answers = {}
    leaf_sels = wanted_leaves(tree, want)
    for sel, res in zip(leaf_sels, await asyncio.gather(*(matched(s) for s in leaf_sels))):
        if not res:
            continue
        answers[sel] = res
        chain, up = res.get("inherited", []), ancestors(sel)
        # A chain that doesn't line up with the selector's ancestors (the
        # flat tree differs from the DOM, e.g. slotted content) can't be trusted.
        if len(chain) != len(up):
            continue
        for i, anc in enumerate(up):
            if anc in in_tree and anc not in answers:
                answers[anc] = {
                    "matchedCSSRules": chain[i].get("matchedCSSRules", []),
                    "inlineStyle": chain[i].get("inlineStyle"),
                    "inherited": chain[i + 1:],
                }
    missing = [s for s in sels if s not in answers]
    for sel, res in zip(missing, await asyncio.gather(*(matched(s) for s in missing))):
        if res:
            answers[sel] = res
    results = [answers.get(s) for s in sels]

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

    # A dict, not a set, so sheets come out in first-use order on every run.
    rules, index, used_sheets = [], {}, {}

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
            used_sheets[sheet] = None
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


def normal_url(url):
    """A URL without its fragment or trailing slash, for telling whether two URLs are the same page."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path.rstrip("/") or "/", parts.query, ""))


# Vite adds `?t=<timestamp>` to modules it has hot-reloaded; the same code
# otherwise. Kept in step with HMR_STAMP in src/fingerprint.ts.
HMR_STAMP = re.compile(r"([?&])t=\d{10,}&?")
HASHED_TYPES = {"script", "stylesheet", "image", "font", "media"}


def resource_key(url):
    return HMR_STAMP.sub(lambda m: m.group(1), url).rstrip("?&")


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Inbox:
    """Replies from tunnelvision, keyed by page index."""

    def __init__(self):
        self.waiting = {}

    def expect(self, index):
        fut = asyncio.get_running_loop().create_future()
        self.waiting[index] = fut
        return fut

    def deliver(self, msg):
        fut = self.waiting.pop(msg.get("index"), None)
        if fut and not fut.done():
            fut.set_result(msg)

    def fail_all(self):
        for fut in self.waiting.values():
            if not fut.done():
                fut.set_result({})
        self.waiting.clear()


async def ask(inbox, msg):
    reply = inbox.expect(msg["index"])
    emit(msg)
    return await reply


async def fingerprint(context, page, job, bodies):
    """The page's render fingerprint: its normalized DOM and CSS, and every script, stylesheet, image and font it uses."""
    found = await page.evaluate(job["fingerprintJs"])
    loaded = dict(bodies)
    # Media the page refers to but hasn't loaded yet (lazy images below the fold).
    missing = [u for u in dict.fromkeys(found["urls"]) if resource_key(u) not in loaded]

    async def fetch(url):
        try:
            res = await context.request.get(url, timeout=5000)
            return resource_key(url), digest(await res.body())
        except Exception:
            return resource_key(url), "unavailable"

    for key, value in await asyncio.gather(*(fetch(u) for u in missing)):
        loaded[key] = value
    resources = sorted(loaded.items())
    h = hashlib.sha256()
    h.update("\n".join(found["dom"]).encode())
    h.update(b"\n--css--\n" + found["css"].encode())
    h.update(b"\n--resources--\n" + "\n".join(f"{k} {v}" for k, v in resources).encode())
    return h.hexdigest(), found["dom"], resources


class Slots:
    """
    Pages are loaded and fingerprinted `load` at a time, and settled,
    screenshotted and read `capture` at a time: loading is mostly waiting, so
    more pages can do it at once than can be captured without slowing each
    other down.
    """

    def __init__(self, load, capture):
        self.load = asyncio.Semaphore(load)
        self.capture = asyncio.Semaphore(capture)


async def open_page(browser, job, index, page_job, inbox):
    """
    Load the page and fingerprint it. Returns the context and page when it
    still needs capturing, or None when it's finished (redirected, carried
    over, or fingerprinted only).
    """
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
        bodies = {}
        pending = []

        async def hash_body(res):
            try:
                kind = res.request.resource_type
                if kind not in HASHED_TYPES or not 200 <= res.status < 300:
                    return
                if kind == "media" or res.status == 206:
                    # Audio and video stream in byte ranges, which differ load to
                    # load, so they're identified by their validators instead.
                    h = await res.all_headers()
                    total = (h.get("content-range") or "").rpartition("/")[2] or h.get("content-length", "")
                    tag = f"{h.get('etag', '')}|{h.get('last-modified', '')}|{total}"
                    bodies[resource_key(res.url)] = digest(tag.encode())
                else:
                    bodies[resource_key(res.url)] = digest(await res.body())
            except Exception:
                pass

        page.on("response", lambda res: pending.append(asyncio.ensure_future(hash_body(res))))
        await page.goto(page_job["url"])
        landed = normal_url(page.url)
        if landed != normal_url(page_job["url"]) and landed in set(map(normal_url, job.get("knownUrls", []))):
            emit({"index": index, "event": "redirect", "url": page.url})
            await context.close()
            return None
        # Let hydration scripts finish loading. Components that hydrate
        # after the stabilize scroll pass never see their scroll-triggered
        # reveals fire. Capped, since some pages never go idle (polling).
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
        if page_job.get("wait"):
            await page.wait_for_timeout(page_job["wait"])
        await page.evaluate(job["hydrateJs"])
        await asyncio.gather(*pending)
        fp, dom, resources = await fingerprint(context, page, job, bodies)
        if job.get("mode") == "fingerprint":
            emit({"index": index, "event": "fingerprint", "fingerprint": fp, "dom": dom, "resources": resources})
            await context.close()
            return None
        if job.get("cheat"):
            reply = await ask(inbox, {"index": index, "event": "fingerprint", "fingerprint": fp})
            if reply.get("carry"):
                await context.close()
                return None
        else:
            emit({"index": index, "event": "fingerprint", "fingerprint": fp})
        return context, page
    except Exception:
        await context.close()
        raise


async def settle_and_read(page, job, index, page_job, inbox):
    """Settle the page, screenshot it, extract its elements and read the styles tunnelvision asks for."""
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
    changed = []
    if job.get("changedSelectors"):
        changed = await page.evaluate(
            job["matchJs"], {"selectors": job["changedSelectors"], "elements": list(selectors(tree))}
        )
    reply = await ask(inbox, {"index": index, "event": "extracted", "tree": tree, "changed": changed})
    query = reply.get("query", "all")
    styles = None
    if query:
        try:
            styles = await read_styles(page, tree, None if query == "all" else set(query))
        except Exception:
            styles = None
    emit({"index": index, "event": "done", "styles": styles})


async def capture(browser, job, index, page_job, slots, inbox):
    try:
        async with slots.load:
            opened = await open_page(browser, job, index, page_job, inbox)
        if not opened:
            return
        context, page = opened
        try:
            async with slots.capture:
                await settle_and_read(page, job, index, page_job, inbox)
        finally:
            await context.close()
    except Exception as err:  # report and carry on with the other pages
        emit({"index": index, "event": "error", "error": str(err).splitlines()[0]})


async def read_stdin():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 30)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    return reader


async def listen(reader, inbox):
    while True:
        line = await reader.readline()
        if not line:
            inbox.fail_all()
            return
        try:
            inbox.deliver(json.loads(line))
        except ValueError:
            pass


async def main():
    reader = await read_stdin()
    job = json.loads(await reader.readline())
    inbox = Inbox()
    listener = asyncio.ensure_future(listen(reader, inbox))
    concurrency = max(1, int(job.get("concurrency", 4)))
    slots = Slots(max(concurrency, int(job.get("loadConcurrency", concurrency))), concurrency)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            await asyncio.gather(
                *(capture(browser, job, i, pj, slots, inbox) for i, pj in enumerate(job["pages"]))
            )
        finally:
            listener.cancel()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
