# Reduce fleet RAM while preserving agent performance

The first change to evaluate is how Marveen admits simultaneous headless turns. The governor can start several CLI processes before their memory use appears in the host sample. A blanket one-turn limit would prevent that burst but make independent agents wait even on a machine with spare capacity. Measure the burst, then reserve enough memory for each launch to let independent work proceed where it fits.

This is an implementation plan based on source inspection at `d8ca704a`. The dominant consumer on a particular installation and the achievable savings still need measurement.

## 1. Establish a comparable baseline

Replay four workloads on the same machine and, for container deployments, under the same memory limit. Run an idle fleet for an hour, replay a burst of independent tool-using turns, run a multi-turn task that must recall an earlier decision after resume, and overlap a scheduled build with an interactive request. Include the actual mix of headless and persistent agents. Hold model, reasoning effort, tools, prompts, repository revision and arrival times fixed. Reset workspace and session fixtures between runs.

Sample once per second and on spawn and exit. Record host available memory, service cgroup usage and OOM events where available, dashboard heap and RSS, active and queued turns, oldest queue age, and each CLI process tree including tool children. On Linux use proportional set size for process attribution to avoid counting shared pages repeatedly. Record idle baseline, burst peak and settled memory five minutes after completion. Keep prompts and output out of metrics.

Score tasks with acceptance checks such as passing fixture tests, recovering the earlier decision, and delivering one scheduled result. Record successful tasks per hour, queue-to-completion p95, retries and tokens per successful task. Pair at least five baseline and candidate runs, alternating order. Increase repetitions if the difference is within run-to-run noise.

## 2. Reserve memory before spawning

Extend [the fleet governor](../../src/web/fleet-governor.ts). Its default sizing assumes 2,200 MiB per turn and a 2,500 MiB host reserve. Its live floor uses host memory and only applies once a turn is active. These are distinct controls. The host can appear healthy while a container is nearly full.

- Compute effective headroom from the smaller of host available memory and remaining capacity under applicable finite cgroup limits, including parent limits. Handle unlimited or unreadable limits and retain the platform fallback. Expose the limiting source in the existing governor status.
- Estimate startup cost per CLI from peak incremental usage in the baseline. Reserve it synchronously when granting a slot. Subtract outstanding startup reservations from effective headroom before admitting another turn, releasing the reservation as observed usage takes over. Avoid counting resident bytes twice. Keep the configured concurrency ceiling and one active turn per agent.
- Apply the floor to the first turn as well. Surface the requested memory, headroom and wait reason when even one turn cannot fit. Retry on completion or pressure recovery with a recovery margin to avoid rapid stop/start cycles. Preserve priority ordering and test that deferred background work eventually drains after the burst.
- Test with injected memory samples and simultaneous enqueues in [the governor suite](../../src/__tests__/headless-governor.test.ts). Cover tight container limits on a large host, falling headroom, cancellation and recovery. Run the policy in observation mode first and compare predicted holds with actual peaks and queue times.

## 3. Reclaim memory when headless turns finish

[The headless runner](../../src/web/headless-runner.ts) resolves a cancelled or timed-out turn immediately after signalling its process group. The governor can reuse that slot while the old process is still exiting. Track termination separately from caller notification. Release capacity after confirmed exit and descendant cleanup. Exercise a CLI fixture that spawns a tool child and delays termination, then immediately enqueue a successor. Check for surviving children, double settlement and overlapping memory peaks on each supported platform.

The runner bounds its diagnostic log, but collects response chunks until completion and buffers a Codex JSONL record until a newline arrives. Measure these separately with a large valid reply, a split multibyte character and an unterminated record. Decode incrementally and spool oversized valid output to a private temporary file with backpressure. Stream it through consumers that support streaming. Inventory callers requiring a complete string and measure their final materialization peak before enabling this path. Give malformed or oversized events an explicit failure path and clean up files after success, cancellation, disk-full errors and restart. Compare delivered text and persisted thread IDs with the baseline byte for byte on deterministic fixtures.

## 4. Optimize the largest remaining consumer

Use the baseline to choose the next change. If queued prompt closures dominate, retain durable work IDs in the queue and load payloads at dispatch. Test cancellation, ordering, restart and duplicate delivery. If persistent idle CLI trees dominate, pilot idle suspension only on a backend with verified session resume. Require a quiet period with no pending tool calls, approvals or deliveries. Verify context recall, tool continuity and wake latency before expanding. If build or test children dominate, route eligible launches through the [existing heavy-job gate](../en/heavy-job-gate.md) and test interactive responsiveness during a build. Profile dashboard retainers only if its settled heap grows across repeated identical bursts.

## 5. Release criteria and rollback

Proposed pilot target: reduce peak fleet memory by at least 20% on the pressure workload, keep the configured host reserve available and record zero OOM kills. Require all deterministic correctness and continuity checks to pass. On representative agent tasks require baseline-or-better success rate and successful tasks per hour. Investigate any p95 latency or tokens-per-success increase above 5%. Treat inconclusive comparisons as a reason to collect more runs. Report per-workload numbers so idle savings cannot conceal a slower interactive turn.

Ship admission, cleanup, output handling and suspension independently. Enable one change on one representative fleet, replay the suite, then observe a full scheduled-work cycle. Publish paired measurements with the host size, container limit and CLI mix in the implementation PR. If a gate fails, disable the candidate policy for new work, drain active turns and replay the failing case before expanding.
