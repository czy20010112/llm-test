#!/usr/bin/env python3
"""Read-only: active codex provider config, proxy timeouts, request log failure/output analysis."""
import sqlite3, json, sys, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

con = sqlite3.connect("file:C:/Users/CZY098/.cc-switch/cc-switch.db?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

print("== active codex provider config ==")
r = cur.execute("select * from providers where id='7ca8b6cf-eda3-4766-b64a-7cb85dc3b89d'").fetchone()
if r:
    d = dict(r)
    print("name:", d["name"], "is_current:", d["is_current"], "provider_type:", d["provider_type"])
    print("settings_config:", d["settings_config"][:2500])

print("\n== proxy_config ==")
for r in cur.execute("select * from proxy_config"):
    print(json.dumps(dict(r), ensure_ascii=False, default=str)[:900])

print("\n== provider_health ==")
for r in cur.execute("select * from provider_health"):
    print(json.dumps(dict(r), ensure_ascii=False, default=str)[:400])

print("\n== request logs: status codes (all) ==")
for r in cur.execute("select status_code, count(*) n from proxy_request_logs group by status_code order by n desc"):
    print(" ", dict(r))

print("\n== request logs: distinct error messages (top 25) ==")
for r in cur.execute("select error_message, count(*) n from proxy_request_logs where error_message is not null and error_message != '' group by error_message order by n desc limit 25"):
    print(f"  [{r['n']}] {str(r['error_message'])[:300]}")

print("\n== output_tokens: max and cap candidates (last 3000 requests) ==")
rows = cur.execute("select output_tokens, status_code from proxy_request_logs where output_tokens is not null order by rowid desc limit 3000").fetchall()
outs = [r["output_tokens"] for r in rows]
if outs:
    outs_sorted = sorted(outs, reverse=True)
    print("  top 20 output sizes:", outs_sorted[:20])
    from collections import Counter
    top = Counter(outs).most_common(15)
    print("  most common exact sizes:", top)
    big = [o for o in outs if o >= 4000]
    print(f"  requests with output>=4000: {len(big)} / {len(outs)}; max={max(outs)}")

print("\n== last 25 requests ==")
for r in cur.execute("select created_at, model, request_model, input_tokens, output_tokens, status_code, error_message, duration_ms from proxy_request_logs order by rowid desc limit 25"):
    d = dict(r)
    d["error_message"] = str(d.get("error_message") or "")[:120]
    print(" ", json.dumps(d, ensure_ascii=False, default=str)[:260])

print("\n== today's failures by hour ==")
for r in cur.execute("""select date(created_at/1000,'unixepoch','+8 hours') day,
    strftime('%H', created_at/1000,'unixepoch','+8 hours') hr,
    count(*) n,
    sum(case when status_code != 200 or error_message is not null then 1 else 0 end) fails
    from proxy_request_logs
    where created_at > (strftime('%s','now')-86400*2)*1000
    group by day, hr order by day, hr"""):
    print(" ", dict(r))
