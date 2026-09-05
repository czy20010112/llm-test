#!/usr/bin/env python3
"""Deeper rollout analysis: token usage trend, compaction entries, turn endings."""
import json, sys, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

path = sys.argv[1]
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
objs = []
for ln in lines:
    try:
        objs.append(json.loads(ln))
    except Exception:
        objs.append(None)

print("== event_msg type counts ==")
ev = collections.Counter()
for o in objs:
    if o and o.get("type") == "event_msg":
        ev[o["payload"].get("type")] += 1
for k, v in ev.most_common(40):
    print(f"  {k}: {v}")

print("\n== compacted entries ==")
for i, o in enumerate(objs):
    if o and o.get("type") == "compacted":
        print(f"line {i}: {json.dumps(o, ensure_ascii=False)[:800]}")

print("\n== token_usage_records (last 25) ==")
tus = [o for o in objs if o and o.get("type") == "token_usage_record"]
if tus:
    print("SAMPLE STRUCTURE:", json.dumps(tus[-1], ensure_ascii=False)[:900])
max_in = 0
max_tot = 0
out_sizes = []
for o in tus:
    p = o.get("payload", {})
    tu = p.get("total_token_usage") or p.get("token_usage") or p
    # find numeric fields
    nums = {k: v for k, v in tu.items() if isinstance(v, (int, float))}
    if nums:
        out_sizes.append((o.get("timestamp"), p.get("turn_id"), nums))
for ts, tid, nums in out_sizes[-25:]:
    print(f"  {ts} turn={str(tid)[-8:]} {nums}")

print("\n== turn endings: task_complete context ==")
for i, o in enumerate(objs):
    if o and o.get("type") == "event_msg" and o["payload"].get("type") in ("task_complete", "turn_aborted", "stream_error", "turn_failed"):
        et = o["payload"].get("type")
        # find preceding assistant message
        prev_msg = ""
        for j in range(i - 1, max(0, i - 30), -1):
            pj = objs[j]
            if pj and pj.get("type") == "response_item" and pj["payload"].get("type") == "message" and pj["payload"].get("role") == "assistant":
                prev_msg = "".join(c.get("text", "") for c in pj["payload"].get("content", []))
                break
        print(f"  [{o.get('timestamp')}] {et} payload={json.dumps(o['payload'], ensure_ascii=False)[:200]}")
        print(f"     prev assistant tail: ...{prev_msg[-260:]!r}")
