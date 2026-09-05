#!/usr/bin/env python3
"""Analyze a Codex session rollout jsonl: turn endings, finish reasons, errors, compaction."""
import json, sys, collections

path = sys.argv[1]
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
print(f"file: {path}  lines: {len(lines)}")

finish_counts = collections.Counter()
errors = []
compactions = []
kinds = collections.Counter()
turns = []
last = []

for i, ln in enumerate(lines):
    try:
        o = json.loads(ln)
    except Exception:
        continue
    t = o.get("type", "?")
    kinds[t] += 1
    payload = o.get("payload", o)
    if t == "response_item":
        pt = payload.get("type")
        if pt == "message":
            for item in payload.get("content", []):
                txt = item.get("text", "")
                if "context compaction" in txt or "compacted" in txt.lower():
                    compactions.append((i, txt[:120]))
        if pt == "reasoning":
            pass
        if pt == "function_call_output":
            s = json.dumps(payload.get("output", ""))[:200]
            if "error" in s.lower() or "failed" in s.lower():
                pass
        # finish reasons appear in message items for assistant? check 'status'
        if payload.get("status") in ("completed", "failed") and pt in ("message",):
            pass
    # generic scan
    s = ln
    if '"finish_reason"' in s:
        try:
            p = payload
            def walk(x):
                if isinstance(x, dict):
                    if "finish_reason" in x:
                        finish_counts[str(x.get("finish_reason"))] += 1
                    for v in x.values(): walk(v)
                elif isinstance(x, list):
                    for v in x: walk(v)
            walk(p)
        except Exception:
            pass
    if t == "event_msg":
        et = payload.get("type")
        if et and ("error" in str(et).lower() or "compact" in str(et).lower() or "turn" in str(et).lower()):
            msg = payload.get("message") or payload.get("compaction") or ""
            if et.endswith("_error") or "error" in str(et).lower():
                errors.append((i, et, str(msg)[:300]))
            if "compact" in str(et).lower():
                compactions.append((i, str(et)))
    last.append(ln)
    if len(last) > 40:
        last.pop(0)

print("\n== entry types ==", dict(kinds))
print("\n== finish_reason counts ==", dict(finish_counts))
print(f"\n== compaction-ish events: {len(compactions)} ==")
for c in compactions[-10:]:
    print("  ", c)
print(f"\n== error events: {len(errors)} ==")
for e in errors[-15:]:
    print("  ", e)
print("\n== last entries (truncated) ==")
for ln in last:
    try:
        o = json.loads(ln)
        p = o.get("payload", o)
        if o.get("type") == "response_item" and p.get("type") == "message":
            role = p.get("role")
            txt = "".join(c.get("text", "") for c in p.get("content", []))[:300]
            print(f"  [{o.get('type')}/{p.get('type')} {role}] {txt}")
        elif o.get("type") == "event_msg":
            print(f"  [event {p.get('type')}] {str(p.get('message',''))[:200]}")
        elif o.get("type") == "turn_context":
            print(f"  [turn_context] {json.dumps(p)[:200]}")
        else:
            print(f"  [{o.get('type')}] {ln[:200]}")
    except Exception:
        print("  ", ln[:160])
