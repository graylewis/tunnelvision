---
status: proposed
---

# A visual change is counted in pixels, not as a share of the crop

An element or page counted as changed when its mismatched pixels were more than `maxDiffPercent` of its crop. That makes the smallest change tunnelvision can see depend on the size of the smallest element around it. At the default 0.03%, a 1280×800 page needs about 307 changed pixels, a 992×217 card about 65, a chip less than one: an 8×8 status dot recoloured inside a card falls under the cutoff, and inside a page it isn't seen at all. Whether a change is detected would then depend on how a page happens to be divided into elements, which breaks the first north star (README). A visual change now counts when at least a set number of pixels differ (one by default), whatever the crop's size.

The percentage wasn't hiding noise worth hiding. On human-interfaces, about 1,600 elements on pages a branch didn't touch (26 Oct 2026), and the 1,935 elements of the 7 Oct noise run, had no mismatched pixels at all, with the same machine, a pinned Chromium, pixelmatch's `threshold: 0.1` and `includeAA: false`. Noise comes from the environment and is handled there: a Version records its browser and platform so a diff between Versions that differ warns, and stabilising freezes animations. `maxDiffPercent` stays as an opt-in for projects that can't make capture deterministic.

## Consequences

- One stray pixel now falls inside every ancestor's crop. An ancestor whose box stayed put was already a knock-on effect of the explained changes inside it. One that changed nothing of its own, and whose changed pixels all lie inside unexplained changes below it, is now marked downstream of them (`downstreamOf` in the report), so an unexplained chain counts as one change. On human-interfaces (`f875f2a..4eca9af`), with ADRs 0013 and 0015, unexplained changes went from 557 to 2.
- pixelmatch's colour threshold is a second cutoff: a colour shift below 0.1 is never counted at any size. It needs the same review against the first north star.
