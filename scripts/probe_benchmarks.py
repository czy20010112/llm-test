#!/usr/bin/env python3
"""Stream-probe Hugging Face benchmark datasets: schema + first row(s).
Run inside WSL with proxy env vars set (see docker/wsl-env.sh)."""
import json, os, sys, textwrap

REPOS = [
    ("longbench2", "THUDM/LongBench-v2", "test"),
    ("humaneval_plus", "Muennighoff/humaneval-plus", "test"),
    ("mbpp_plus", "Muennighoff/mbpp-plus", "test"),
    ("ds1000", "xlang-ai/DS-1000", "test"),
    ("livecodebench", "livecodebench/code_generation_lite", "test"),
    ("swebench", "princeton-nlp/SWE-bench", None),
]

def clip(v, n=300):
    s = str(v)
    return s if len(s) <= n else s[:n] + f"... [+{len(s)-n} chars]"

def main():
    from datasets import load_dataset
    for name, repo, split in REPOS:
        print("=" * 70)
        print(f"### {name}  repo={repo} split={split}")
        try:
            if split is None:
                # SWE-bench: inspect splits first
                from huggingface_hub import hf_hub_download
                import urllib.request, json as _json
                url = f"https://huggingface.co/api/datasets/{repo}"
                req = urllib.request.Request(url, headers={"User-Agent": "llm-test-probe"})
                meta = _json.load(urllib.request.urlopen(req, timeout=30))
                print("siblings:")
                for s in meta.get("siblings", []):
                    print("   ", s.get("rfilename"))
                continue
            ds = load_dataset(repo, split=split, streaming=True)
            print("features:", json.dumps(ds.features.to_dict(), indent=1, default=str)[:2000])
            for i, row in enumerate(ds):
                if i >= 1:
                    break
                print(f"--- row {i} ---")
                for k, v in row.items():
                    print(f"  {k}: {clip(v)}")
        except Exception as e:
            print(f"ERROR: {type(e).__name__}: {e}")

if __name__ == "__main__":
    main()
