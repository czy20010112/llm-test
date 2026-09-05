#!/usr/bin/env python3
"""Code judge service for llm-test.

Runs model-generated Python code in restricted subprocesses and scores it.
Modes:
  stdin : run solution.py per test case with stdin input, compare stdout (LiveCodeBench text tasks)
  tests : concat code + check snippet (HumanEval+ / MBPP+ evalplus style, def check(candidate))
  file  : write solution.py + test file, run the test file which imports the solution (LiveCodeBench func tasks)

Security: this container runs on an internal docker network (no external egress).
Every executed test gets CPU/memory/filesize/process limits and a wall-clock timeout.
"""
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="llm-test code judge")

DEFAULT_TIMEOUT = 10.0
MAX_TIMEOUT = 120.0
MEM_LIMIT = 2 * 1024**3      # 2 GiB address space per test
FSIZE_LIMIT = 64 * 1024**2   # 64 MiB max file a test may write
NPROC_LIMIT = 64             # max processes
CPU_LIMIT_PAD = 4            # seconds added on top of wall timeout


class JudgeRequest(BaseModel):
    mode: str = Field(pattern="^(stdin|tests|file)$")
    code: str
    entry_point: str | None = None
    test_cases: list[str] | None = None      # stdin mode: "input\x00expected" pairs OR list of check snippets
    test_pairs: list[dict] | None = None     # stdin mode: [{input, expected}]
    test_code: str | None = None             # tests mode: full check snippet (def check(candidate): ...)
    test_file: str | None = None             # file mode: test script content
    solution_name: str = "solution.py"       # file mode: module name the test file imports
    timeout: float = Field(default=DEFAULT_TIMEOUT, gt=0, le=MAX_TIMEOUT)
    max_tests: int | None = Field(default=None, gt=0, le=500)


def _limits(wall: float):
    def pre():
        cpu = int(wall) + CPU_LIMIT_PAD
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
            resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
            resource.setrlimit(resource.RLIMIT_FSIZE, (FSIZE_LIMIT, FSIZE_LIMIT))
            resource.setrlimit(resource.RLIMIT_NPROC, (NPROC_LIMIT, NPROC_LIMIT))
        except Exception:
            pass
    return pre


def _run(cmd, cwd, timeout, stdin_data=None):
    """Run cmd in its own session; kill the whole process group on timeout."""
    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True,
            preexec_fn=_limits(timeout),
        )
    except Exception as e:
        return 127, "", f"spawn error: {e}"
    try:
        out, err = proc.communicate(input=stdin_data, timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass
        out, err = proc.communicate()
        return -1, out.decode("utf-8", "replace"), err.decode("utf-8", "replace") + "\n[TIMEOUT]"


def _compile_check(code: str):
    try:
        compile(code, "<solution>", "exec")
        return None
    except SyntaxError as e:
        return f"syntax error line {e.lineno}: {e.msg}"


def _norm(s: str) -> str:
    return "\n".join(line.rstrip() for line in s.replace("\r\n", "\n").strip().split("\n")).strip()


def _judge_stdin(req: JudgeRequest, workdir: str) -> list[dict]:
    sol = os.path.join(workdir, "solution.py")
    with open(sol, "w") as f:
        f.write(req.code)
    pairs = req.test_pairs or []
    if not pairs and req.test_cases:
        for c in req.test_cases:
            if "\x00" in c:
                i, e = c.split("\x00", 1)
                pairs.append({"input": i, "expected": e})
    results = []
    for idx, p in enumerate(pairs):
        rc, out, err = _run([sys.executable, "solution.py"], workdir, req.timeout, stdin_data=(p.get("input") or "").encode())
        expected = _norm(p.get("expected") or "")
        got = _norm(out)
        ok = rc == 0 and got == expected
        results.append({
            "id": idx, "passed": ok,
            "detail": "" if ok else (f"rc={rc} got={got[:300]!r} expected={expected[:300]!r}" + (f" stderr={err[-300:]}" if err.strip() else "")),
        })
    return results


def _judge_tests(req: JudgeRequest, workdir: str) -> list[dict]:
    snippets = []
    if req.test_code:
        snippets.append(req.test_code)
    if req.test_cases:
        snippets.extend(req.test_cases)
    results = []
    for idx, snippet in enumerate(snippets):
        body = req.code + "\n\n" + snippet + "\n"
        # If the snippet defines check(candidate), invoke it with the module itself.
        if "def check(" in snippet:
            body += "\ncheck(__main__)\n"
        path = os.path.join(workdir, f"case_{idx}.py")
        with open(path, "w") as f:
            f.write(body)
        rc, out, err = _run([sys.executable, f"case_{idx}.py"], workdir, req.timeout)
        ok = rc == 0
        results.append({
            "id": idx, "passed": ok,
            "detail": "" if ok else f"rc={rc} stderr={err[-400:]}",
        })
    return results


def _judge_file(req: JudgeRequest, workdir: str) -> list[dict]:
    sol = os.path.join(workdir, req.solution_name)
    with open(sol, "w") as f:
        f.write(req.code)
    test_path = os.path.join(workdir, "test_run.py")
    with open(test_path, "w") as f:
        f.write(req.test_file or "")
    rc, out, err = _run([sys.executable, "test_run.py"], workdir, req.timeout)
    ok = rc == 0
    return [{
        "id": 0, "passed": ok,
        "detail": "" if ok else f"rc={rc} out={out[-200:]!r} stderr={err[-400:]}",
    }]


@app.get("/health")
def health():
    return {"ok": True, "mode": "judge"}


@app.post("/judge")
def judge(req: JudgeRequest):
    syntax_err = _compile_check(req.code)
    if syntax_err:
        return {"passed": 0, "total": 0, "all_passed": False, "compile_error": syntax_err, "results": []}

    workdir = tempfile.mkdtemp(prefix=f"judge-{uuid.uuid4().hex[:8]}-", dir="/tmp")
    try:
        if req.mode == "stdin":
            results = _judge_stdin(req, workdir)
        elif req.mode == "tests":
            results = _judge_tests(req, workdir)
        else:
            results = _judge_file(req, workdir)
        if req.max_tests and len(results) > req.max_tests:
            results = results[: req.max_tests]
        passed = sum(1 for r in results if r["passed"])
        return {
            "passed": passed,
            "total": len(results),
            "all_passed": bool(results) and passed == len(results),
            "compile_error": None,
            "results": results,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
