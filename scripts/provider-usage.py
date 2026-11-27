"""Read the most recently recorded CLI usage without sending a model request."""
import json
import os
from pathlib import Path


def latest(paths, parse, cumulative):
    for path in sorted(paths, key=lambda p: p.stat().st_mtime, reverse=True):
        result = None
        with path.open(errors="replace") as stream:
            for line in stream:
                entry = parse(line)
                if entry is not None:
                    if not cumulative:
                        previous = result or {}
                        entry["lastInput"] = entry["input"]
                        entry["lastOutput"] = entry["output"]
                        for key in ("input", "output", "cached"):
                            entry[key] += previous.get(key, 0)
                    result = entry
        if result is not None:
            return result


def codex(line):
    if '"token_count"' not in line:
        return None
    try:
        event = json.loads(line)
        payload = event["payload"]
        if event.get("type") != "event_msg" or payload.get("type") != "token_count":
            return None
        info = payload["info"]
        total = info["total_token_usage"]
        last = info.get("last_token_usage") or {}
        return dict(input=total["input_tokens"], output=total["output_tokens"],
                    cached=total.get("cached_input_tokens"), lastInput=last.get("input_tokens"),
                    lastOutput=last.get("output_tokens"), at=event["timestamp"])
    except (TypeError, KeyError, ValueError):
        return None


def agy(line):
    if '"input_tokens"' not in line:
        return None
    try:
        step = json.loads(line)
        if step.get("type") != "PLANNER_RESPONSE":
            return None
        cached = step.get("cache_read_tokens", 0)
        return dict(input=step["input_tokens"] + cached, output=step["output_tokens"],
                    cached=cached, at=step["created_at"])
    except (TypeError, ValueError, KeyError):
        return None


def collect():
    home = Path.home()
    sources = {
        "codex": (Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions", "**/rollout-*.jsonl", codex),
        "agy": (home / ".gemini/antigravity-cli/brain", "*/.system_generated/logs/transcript.jsonl", agy),
    }
    results = {}
    for name, (root, pattern, parse) in sources.items():
        try:
            results[name] = latest(root.glob(pattern), parse, name == "codex")
        except OSError:
            results[name] = None
    return results


if __name__ == "__main__":
    print(json.dumps(collect()))
