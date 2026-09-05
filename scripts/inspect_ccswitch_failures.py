#!/usr/bin/env python3
"""Read-only: timeline of non-200 proxy requests (last 48h) + big-output requests."""
import sqlite3, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
con = sqlite3.connect("file:C:/Users/CZY098/.cc-switch/cc-switch.db?mode=ro", uri=True)
cur = con.cursor()

print("== non-200 requests, last 48h (Beijing time) ==")
q = """
select created_at,
       model, input_tokens, output_tokens, status_code,
       substr(coalesce(error_message,''),1,160) err
from proxy_request_logs
where status_code != 200 or coalesce(error_message,'') != ''
order by rowid desc limit 120
"""
n = 0
for r in cur.execute(q):
    n += 1
    print(" ", " | ".join(str(x) for x in r))
print(f"shown: {n}")

print("\n== sample of text-format created_at rows (newest 10) ==")
for r in cur.execute("select created_at, status_code, output_tokens from proxy_request_logs where typeof(created_at)='text' order by rowid desc limit 10"):
    print(" ", " | ".join(str(x) for x in r))

print("\n== hourly failure counts, last 48h ==")
q2 = """
select datetime(created_at,'unixepoch','+8 hours','start of hour') hr,
       count(*) total,
       sum(case when status_code != 200 then 1 else 0 end) fails
from proxy_request_logs
where created_at > (strftime('%s','now') - 172800)
group by hr order by hr
"""
for r in cur.execute(q2):
    print(" ", " | ".join(str(x) for x in r))

print("\n== requests with output >= 8000 (last 7 days) ==")
q3 = """
select datetime(created_at,'unixepoch','+8 hours') t, model, input_tokens, output_tokens, status_code
from proxy_request_logs
where output_tokens >= 8000 and created_at > (strftime('%s','now') - 604800)
order by created_at
"""
for r in cur.execute(q3):
    print(" ", " | ".join(str(x) for x in r))
