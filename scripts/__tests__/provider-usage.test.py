"""Contract test for the local usage collector using both CLI transcript formats."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ProviderUsageTest(unittest.TestCase):
    def test_cumulative_and_per_request_counters(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex = root / "custom-codex/sessions/2026/11/20/rollout-1.jsonl"
            agy = root / ".gemini/antigravity-cli/brain/1/.system_generated/logs/transcript.jsonl"
            for path in (codex, agy):
                path.parent.mkdir(parents=True)
            counts = {"input_tokens": 80, "cached_input_tokens": 20, "output_tokens": 5}
            event = {"type": "event_msg", "timestamp": "2026-11-20T12:00:00Z", "payload": {
                "type": "token_count", "info": {"total_token_usage": counts, "last_token_usage": counts}}}
            codex.write_text((json.dumps(event) + "\n") * 2)
            step = {"type": "PLANNER_RESPONSE", "input_tokens": 30, "cache_read_tokens": 10,
                    "output_tokens": 4, "created_at": "2026-11-20T12:00:00Z"}
            agy.write_text(json.dumps(step) + "\n" + json.dumps({**step, "input_tokens": 15}) + "\n{")
            command = [sys.executable, str(Path(__file__).resolve().parents[1] / "provider-usage.py")]
            env = {**os.environ, "HOME": tmp, "CODEX_HOME": str(root / "custom-codex")}
            data = json.loads(subprocess.check_output(command, env=env))
            self.assertEqual((data["codex"]["input"], data["codex"]["cached"]), (80, 20))
            self.assertEqual((data["agy"]["input"], data["agy"]["cached"], data["agy"]["lastInput"]), (65, 20, 25))
            agy.unlink()
            self.assertIsNone(json.loads(subprocess.check_output(command, env=env))["agy"])


if __name__ == "__main__":
    unittest.main()
