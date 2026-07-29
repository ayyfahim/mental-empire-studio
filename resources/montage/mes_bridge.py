#!/usr/bin/env python3
"""Mental Empire Studio -> OpenMontage bridge invoker.

This is the ONLY Python that MES ships (under resources/montage, packaged via extraResources).
OpenMontage itself is an external, user-local dependency located at --om-root (settings.openMontageRoot);
we add it to sys.path at runtime so `tools.*` / `lib.*` import. OM is untracked in the MES git repo, so
this shim must never assume OM lives beside it.

Protocol: NDJSON on stdout. One JSON object per line. Progress/stage lines look like
    {"event": "stage", "stage": "footage", "status": "start"|"done", ...}
    {"event": "log", "level": "info"|"warn"|"error", "msg": "..."}
The FINAL line is always
    {"event": "result", "ok": true|false, "data": {...}, "error": null|"..."}
Diagnostics that are not part of the protocol go to stderr. Exit code 0 iff the final result ok.

Commands:
    capabilities --om-root PATH
        -> provider_menu_summary() + runtime probes.
    run-tool --om-root PATH --name TOOL --inputs-file JSON [--discover]
        -> registry.get(TOOL).execute(inputs) (or direct import when --discover omitted).
    produce --om-root PATH --brief-file JSON
        -> deterministic mini-orchestrator: preflight -> footage -> compose -> review.

Secrets (API keys) are expected in os.environ (MES passes them via spawn env); OM's _load_dotenv only
fills keys NOT already set, so env always wins. We never write a .env.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Optional


# --------------------------------------------------------------------------------------
# NDJSON emit helpers (stdout = protocol, stderr = diagnostics)
# --------------------------------------------------------------------------------------

def _force_utf8_streams() -> None:
    """Windows consoles default to cp1252; OpenMontage output contains non-ASCII (em-dashes,
    provider names). Without this, every emit() would raise UnicodeEncodeError and be swallowed,
    producing an empty-but-exit-0 run. Reconfigure both streams to UTF-8 up front."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[attr-defined]
        except Exception:
            pass


def emit(event: str, **fields: Any) -> None:
    line = {"event": event, **fields}
    try:
        payload = json.dumps(line, ensure_ascii=False, default=str)
    except Exception:
        payload = json.dumps({"event": event, "error": "serialize_failed"})
    try:
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()
    except Exception:
        # Last resort: escape to pure ASCII so a stubborn stream still receives valid NDJSON.
        try:
            sys.stdout.write(payload.encode("ascii", "backslashreplace").decode("ascii") + "\n")
            sys.stdout.flush()
        except Exception:  # never let logging crash the run
            pass


def log(msg: str, level: str = "info") -> None:
    emit("log", level=level, msg=msg)


def stage(name: str, status: str, **fields: Any) -> None:
    emit("stage", stage=name, status=status, **fields)


def result(ok: bool, data: Optional[dict] = None, error: Optional[str] = None) -> int:
    emit("result", ok=ok, data=data or {}, error=error)
    return 0 if ok else 1


# --------------------------------------------------------------------------------------
# OpenMontage bootstrap
# --------------------------------------------------------------------------------------

def bootstrap_om(om_root: str) -> Path:
    """Validate + add the OpenMontage root to sys.path so tools.* / lib.* import."""
    root = Path(om_root).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"OpenMontage root not found: {root}")
    if not (root / "tools" / "tool_registry.py").is_file():
        raise FileNotFoundError(
            f"OpenMontage root looks wrong (no tools/tool_registry.py): {root}"
        )
    # cwd + sys.path must be the OM root: OM tools use absolute `tools.`/`lib.` imports.
    sys.path.insert(0, str(root))
    try:
        os.chdir(root)
    except Exception as exc:  # pragma: no cover - defensive
        log(f"could not chdir to OM root: {exc}", "warn")
    return root


def _load_registry():
    from tools.tool_registry import registry  # type: ignore

    registry.discover()
    return registry


def _tool_result_to_dict(res: Any) -> dict:
    """Normalize an OpenMontage ToolResult (dataclass) into a plain dict."""
    def g(name: str, default: Any = None) -> Any:
        return getattr(res, name, default)

    return {
        "success": bool(g("success", False)),
        "data": g("data", {}) or {},
        "artifacts": list(g("artifacts", []) or []),
        "error": g("error"),
        "cost_usd": g("cost_usd"),
        "duration_seconds": g("duration_seconds"),
        "seed": g("seed"),
        "model": g("model"),
    }


# --------------------------------------------------------------------------------------
# capabilities
# --------------------------------------------------------------------------------------

def cmd_capabilities(args: argparse.Namespace) -> int:
    bootstrap_om(args.om_root)
    registry = _load_registry()
    try:
        summary = registry.provider_menu_summary()
    except Exception as exc:
        log(f"provider_menu_summary failed: {exc}", "warn")
        summary = {}

    # Best-effort composition-runtime detail straight from video_compose.get_info().
    render_engines: dict = {}
    try:
        vc = registry.get("video_compose")
        if vc is not None:
            info = vc.get_info()
            render_engines = info.get("render_engines") or info.get("render_runtimes") or {}
    except Exception as exc:
        log(f"video_compose.get_info failed: {exc}", "warn")

    data = {
        "om_root": str(Path(args.om_root).resolve()),
        "python": sys.version.split()[0],
        "summary": summary,
        "render_engines": render_engines,
    }
    return result(True, data)


# --------------------------------------------------------------------------------------
# run-tool
# --------------------------------------------------------------------------------------

def _read_json_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _run_single_tool(registry, name: str, inputs: dict) -> dict:
    tool = registry.get(name)
    if tool is None:
        raise ValueError(f"tool not found in registry: {name}")
    status = None
    try:
        status = tool.get_status()
    except Exception:
        pass
    log(f"executing tool={name} status={status}")
    res = tool.execute(inputs)
    return _tool_result_to_dict(res)


def cmd_run_tool(args: argparse.Namespace) -> int:
    bootstrap_om(args.om_root)
    inputs = _read_json_file(args.inputs_file) if args.inputs_file else {}
    if not isinstance(inputs, dict):
        return result(False, error="inputs must be a JSON object")
    registry = _load_registry()
    try:
        out = _run_single_tool(registry, args.name, inputs)
    except Exception as exc:
        log(traceback.format_exc(), "error")
        return result(False, error=f"{type(exc).__name__}: {exc}")
    return result(bool(out.get("success")), out, out.get("error"))


# --------------------------------------------------------------------------------------
# produce -- deterministic mini-orchestrator (the "agentic" end-to-end flow)
# --------------------------------------------------------------------------------------
#
# brief JSON shape (all optional except output_dir + a compose plan):
# {
#   "project_id": "dl-123",
#   "output_dir": "C:/.../projects/dl-123",
#   "footage": {                      # optional -- when present, run DirectClipSearch
#       "queries": [{"query": "city at night", "slot_id": "s1", "kind": "video"}],
#       "sources": ["archive_org","nasa","pexels"],   # optional; defaults to all available
#       "clips_per_query": 3,
#       "filters": {"orientation": "landscape", "min_duration": 3}
#   },
#   "compose": {                      # required to render
#       "render_runtime": "remotion" | "hyperframes" | "ffmpeg",
#       "edit_decisions": {...},      # OM edit_decisions incl. cuts[]
#       "asset_manifest": {...},      # optional
#       "playbook": {...},            # optional
#       "profile": "youtube-landscape",
#       "output_path": "C:/.../renders/final.mp4"
#   }
# }

def _run_footage(registry, footage: dict, output_dir: str) -> dict:
    queries = footage.get("queries") or []
    if not queries:
        stage("footage", "skip", reason="no queries")
        return {"clips": [], "total_clips": 0}
    inputs: dict = {
        "output_dir": footage.get("output_dir") or output_dir,
        "queries": queries,
    }
    for k in ("sources", "clips_per_query", "filters", "extract_thumbnails", "skip_existing",
              "timeout_seconds"):
        if k in footage:
            inputs[k] = footage[k]
    stage("footage", "start", queries=len(queries), sources=footage.get("sources"))
    out = _run_single_tool(registry, "direct_clip_search", inputs)
    if not out.get("success"):
        raise RuntimeError(f"footage retrieval failed: {out.get('error')}")
    data = out.get("data") or {}
    stage("footage", "done", total_clips=data.get("total_clips"),
          per_source=data.get("per_source_counts"))
    return data


def _run_compose(registry, compose: dict, output_dir: str) -> dict:
    runtime = (compose.get("render_runtime") or "").strip().lower()
    edit_decisions = dict(compose.get("edit_decisions") or {})
    if runtime and not edit_decisions.get("render_runtime"):
        edit_decisions["render_runtime"] = runtime
    runtime = edit_decisions.get("render_runtime") or "ffmpeg"

    output_path = compose.get("output_path") or str(Path(output_dir) / "renders" / "final.mp4")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    inputs: dict = {
        "operation": "render",
        "output_path": output_path,
        "edit_decisions": edit_decisions,
    }
    for k in ("asset_manifest", "playbook", "proposal_packet", "profile", "subtitle_path",
              "subtitle_style", "narration_transcript_path", "script_path", "options"):
        if k in compose:
            inputs[k] = compose[k]

    tool_name = "hyperframes_compose" if runtime == "hyperframes" and compose.get("direct_hyperframes") \
        else "video_compose"
    stage("compose", "start", runtime=runtime, tool=tool_name, output=output_path)
    out = _run_single_tool(registry, tool_name, inputs)
    if not out.get("success"):
        # No silent runtime swap -- surface the structured blocker.
        raise RuntimeError(f"composition ({runtime}) failed: {out.get('error')}")
    data = out.get("data") or {}
    stage("compose", "done", output=data.get("output") or output_path,
          review=data.get("final_review_status"))
    return data


def cmd_produce(args: argparse.Namespace) -> int:
    bootstrap_om(args.om_root)
    brief = _read_json_file(args.brief_file)
    if not isinstance(brief, dict):
        return result(False, error="brief must be a JSON object")

    output_dir = brief.get("output_dir")
    if not output_dir:
        return result(False, error="brief.output_dir is required")
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    stage("preflight", "start")
    registry = _load_registry()
    stage("preflight", "done")

    out_data: dict = {"project_id": brief.get("project_id"), "output_dir": output_dir}
    try:
        footage = brief.get("footage")
        if footage:
            out_data["footage"] = _run_footage(registry, footage, output_dir)

        compose = brief.get("compose")
        if compose:
            out_data["compose"] = _run_compose(registry, compose, output_dir)
            final = out_data["compose"].get("output")
            if final:
                out_data["output"] = final
        stage("done", "done", output=out_data.get("output"))
    except Exception as exc:
        log(traceback.format_exc(), "error")
        stage("done", "error", error=str(exc))
        return result(False, out_data, f"{type(exc).__name__}: {exc}")

    return result(True, out_data)


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mes_bridge", description="MES -> OpenMontage bridge invoker")
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("capabilities", help="probe OpenMontage capabilities")
    c.add_argument("--om-root", required=True)
    c.set_defaults(func=cmd_capabilities)

    r = sub.add_parser("run-tool", help="run one OpenMontage tool")
    r.add_argument("--om-root", required=True)
    r.add_argument("--name", required=True)
    r.add_argument("--inputs-file", required=False)
    r.set_defaults(func=cmd_run_tool)

    pr = sub.add_parser("produce", help="deterministic footage->compose->review orchestration")
    pr.add_argument("--om-root", required=True)
    pr.add_argument("--brief-file", required=True)
    pr.set_defaults(func=cmd_produce)
    return p


def main(argv: Optional[list] = None) -> int:
    _force_utf8_streams()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except SystemExit:
        raise
    except Exception as exc:
        try:
            log(traceback.format_exc(), "error")
        except Exception:
            pass
        return result(False, error=f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
