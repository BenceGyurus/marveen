import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../web/agent-process.js', () => ({
  sessionExistsOnHost: vi.fn(() => true),
}))
vi.mock('../web/claude-cli-version.js', () => ({
  measureClaudeCliVersionSync: () => ({ version: null }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('skips tmux warm-up for both headless worker queues', async () => {
  vi.stubEnv('MARVEEN_WORKER_MODEL', 'codex:gpt-5.4')
  vi.stubEnv('MARVEEN_WORKER_MODEL_FAST', 'agy:gemini')
  vi.stubEnv('MARVEEN_NON_CLAUDE_TMUX', '0')
  vi.stubEnv('MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES', '1')
  vi.stubEnv('WEB_ONLY', 'false')
  const { startWorkerSession, workerStartAllowed } = await import('../web/agent-worker.js')
  const { sessionExistsOnHost } = await import('../web/agent-process.js')
  expect(workerStartAllowed()).toBe(true)
  startWorkerSession()
  expect(sessionExistsOnHost).not.toHaveBeenCalled()

  vi.stubEnv('MARVEEN_NON_CLAUDE_TMUX', '1')
  startWorkerSession()
  expect(sessionExistsOnHost).toHaveBeenCalledTimes(2)
})
