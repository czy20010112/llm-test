#!/usr/bin/env python3
"""Read-only: does any single Qwen request hit a repeated output ceiling? + today's stats."""
import sqlite3, sys, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
con = sqlite3.connect("file:C:/Users/CZY098/.cc-switch/cc-switch.db?mode=ro", uri=True)
cur = con.cursor()

print("== per-model max output (all time) ==")
for r in cur.execute("""select model, max(output_tokens), count(*),
    sum(case when output_tokens=0 then 1 else 0 end)
    from proxy_request_logs group by model order by max(output_tokens) desc limit 15"""):
    print(" ", " | ".join(str(x) for x in r))

print("\n== Qwen3.8-27B-Q8: top exact output sizes (all time) ==")
for r in cur.execute("""select output_tokens, count(*) n from proxy_request_logs
    where model='Qwen3.8-27B-Q8' and output_tokens > 0
    group by output_tokens order by output_tokens desc limit 20"""):
    print(" ", " | ".join(str(x) for x in r))

print("\n== Qwen3.8-27B-Q8 today: max input, max output, count ==")
for r in cur.execute("""select count(*), max(input_tokens), max(output_tokens), min(input_tokens)
    from proxy_request_logs where model='Qwen3.8-27B-Q8'
    and created_at > (strftime('%s','now') - 86400)"""):
    print(" ", " | ".join(str(x) for x in r))

print("\n== Qwen3.8-27B-Q8: requests with output > 5000 today ==")
for r in cur.execute("""select datetime(created_at,'unixepoch','+8 hours'), input_tokens, output_tokens, status_code
    from proxy_request_logs where model='Qwen3.8-27B-Q8' and output_tokens > 5000
    and created_at > (strftime('%s','now') - 86400) order by created_at"""):
    print(" ", " | ".join(str(x) for x in r))
