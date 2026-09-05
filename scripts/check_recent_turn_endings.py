#!/usr/bin/env python3
"""Show the most recent turn endings in the current session rollout."""
import json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

path = r"C:\Users\CZY098\.codex\sessions\2026\09\04\rollout-2026-09-04T19-43-17-01a06c3a-f013-7d33-9ba6-2326e3be8699.jsonl"
lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
objs = []
for ln in lines:
    try:
        objs.append(json.loads(ln))
    except Exception:
        objs.append(None)

completes = [(i, o) for i, o in enumerate(objs) if o and o.get("type") == "event_msg" and o["payload"].get("type") == "task_complete"]
print(f"total task_complete: {len(completes)}; showing last 7")
for idx, (i, o) in enumerate(completes[-7:]):
    p = o["payload"]
    msg = p.get("last_agent_message")
    err = p.get("error")
    print(f"\n[{p.get('timestamp')}] dur={p.get('duration_ms')}ms")
    print(f"  error: {json.dumps(err, ensure_ascii=False)[:300] if err else None}")
    print(f"  last_agent_message: {repr(msg[:200]) if msg else None}")
    # count assistant messages in this turn (since previous task_complete)
    start = completes[idx - 1][0] if idx > 0 else 0
    n_asst = sum(1 for j in range(start, i) if objs[j] and objs[j].get("type") == "response_item" and objs[j]["payload"].get("type") == "message" and objs[j]["payload"].get("role") == "assistant")
    n_tool = sum(1 for j in range(start, i) if objs[j] and objs[j].get("type") == "response_item" and objs[j]["payload"].get("type") in ("function_call", "custom_tool_call"))
    print(f"  turn items: assistant_msgs={n_asst} tool_calls={n_tool}")
