#!/usr/bin/env python3
"""Read-only inspection of cc-switch provider database (Codex provider config)."""
import sqlite3, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

con = sqlite3.connect("file:C:/Users/CZY098/.cc-switch/cc-switch.db?mode=ro", uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("select name from sqlite_master where type='table'")]
print("tables:", tables)
for t in tables:
    cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})")]
    n = cur.execute(f"select count(*) from '{t}'").fetchone()[0]
    print(f"-- {t} ({n} rows): {cols}")

# find provider-ish tables and dump the active codex provider
for t in tables:
    cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})")]
    if any("name" in c.lower() for c in cols) and any("config" in c.lower() or "settings" in c.lower() or "data" in c.lower() for c in cols):
        print(f"\n=== dumping {t} (key columns trimmed) ===")
        rows = cur.execute(f"select * from '{t}' limit 60").fetchall()
        for r in rows:
            d = dict(zip(cols, r))
            for k, v in list(d.items()):
                if isinstance(v, str) and len(v) > 600:
                    d[k] = v[:600] + f"... [+{len(v)-600}]"
            print(json.dumps(d, ensure_ascii=False, default=str)[:1200])
