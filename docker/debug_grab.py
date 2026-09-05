#!/usr/bin/env python3
"""Debug: list real files for the failing repos (read-only, via proxy)."""
import os, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.environ.setdefault("HF_HOME", "/mnt/d/AI/llm-test/benchmarks/hf-cache")
from huggingface_hub import HfApi
api = HfApi()
for repo in ["THUDM/LongBench-v2", "evalplus/humanevalplus", "evalplus/mbppplus", "xlangai/DS-1000", "princeton-nlp/SWE-bench_Verified"]:
    print("=" * 60)
    print("repo:", repo)
    try:
        files = api.list_repo_files(repo, repo_type="dataset")
        print("files:", files)
    except Exception as e:
        print("ERROR:", type(e).__name__, str(e)[:400])
        try:
            import urllib.request, json
            req = urllib.request.Request(f"https://huggingface.co/api/datasets/{repo}/tree/main", headers={"User-Agent": "probe"})
            data = json.load(urllib.request.urlopen(req, timeout=30))
            print("api tree:", [(d["path"], d.get("size")) for d in data][:20])
        except Exception as e2:
            print("api tree ERROR:", type(e2).__name__, str(e2)[:200])
