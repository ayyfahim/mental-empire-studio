#!/usr/bin/env python3
"""Standalone unit test for the MES -> OpenMontage bridge shim (resources/montage/mes_bridge.py).

No pytest / third-party deps required (the repo ships no Python test harness), so this runs under a
bare `python3 test/montage/test_shim.py` and is wired into CI that way. It exercises the shim's error
contract WITHOUT a real OpenMontage install: both cases fail before any `tools.*` import happens.

Checks:
  (a) `capabilities --om-root <bad>`  -> prints a final NDJSON {"event":"result","ok":false,...}
                                          line with a non-empty error, and exits non-zero.
  (b) missing subcommand              -> rejected by argparse (non-zero exit, usage on stderr).

Prints SHIM_TEST_OK on success; SHIM_TEST_FAIL + reason and exits 1 on any failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIM = REPO_ROOT / "resources" / "montage" / "mes_bridge.py"


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SHIM), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(REPO_ROOT),
    )


def _final_result_line(stdout: str) -> dict | None:
    """The shim's protocol: the LAST NDJSON line with event==result is the outcome."""
    found = None
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("event") == "result":
            found = obj
    return found


def _fail(msg: str) -> "int":
    print(f"SHIM_TEST_FAIL {msg}")
    return 1


def check_bad_om_root() -> int:
    # A path guaranteed not to be an OpenMontage checkout -> bootstrap_om raises before OM import.
    bad = Path(tempfile.gettempdir()) / "mes-montage-definitely-not-openmontage-xyz"
    proc = _run(["capabilities", "--om-root", str(bad)])
    result = _final_result_line(proc.stdout)
    if result is None:
        return _fail(f"(a) no final result line. rc={proc.returncode} stdout={proc.stdout!r} stderr={proc.stderr[-400:]!r}")
    if result.get("ok") is not False:
        return _fail(f"(a) expected ok:false, got ok={result.get('ok')!r}")
    if not (isinstance(result.get("error"), str) and result["error"].strip()):
        return _fail(f"(a) expected non-empty error string, got error={result.get('error')!r}")
    if proc.returncode == 0:
        return _fail(f"(a) expected non-zero exit for a failed run, got 0")
    print(f"  (a) bad --om-root -> ok:false error={result['error'][:80]!r} rc={proc.returncode}")
    return 0


def check_missing_subcommand() -> int:
    proc = _run([])
    if proc.returncode == 0:
        return _fail(f"(b) missing subcommand should be rejected, but exit was 0. stdout={proc.stdout!r}")
    if not proc.stderr.strip():
        return _fail("(b) missing subcommand should print an argparse error to stderr, but stderr was empty")
    print(f"  (b) missing subcommand -> rejected rc={proc.returncode}")
    return 0


def main() -> int:
    if not SHIM.is_file():
        return _fail(f"shim not found at {SHIM}")
    print(f"shim: {SHIM}")
    for check in (check_bad_om_root, check_missing_subcommand):
        rc = check()
        if rc != 0:
            return rc
    print("SHIM_TEST_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
