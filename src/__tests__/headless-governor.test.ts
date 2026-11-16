import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeDefaultConcurrency,
  FleetGovernor,
  fleetGovernor,
} from '../web/fleet-governor.js'
import {
  buildHeadlessChildEnv,
  buildHeadlessTurnSpec,
  captureHeadlessPane,
  enqueueHeadlessPrompt,
  isHeadlessAgent,
  isHeadlessSession,
  registerHeadlessAgent,
  runHeadlessWorkerTurn,
  shouldUseHeadlessMode,
  unregisterHeadlessAgent,
} from '../web/headless-runner.js'
import { detectPaneState } from '../pane-state.js'

describe('FleetGovernor & Hardware-Aware Concurrency', () => {
  it('caps 4 vCPU / 12 GB RAM host to 3 concurrent turns', () => {
    expect(computeDefaultConcurrency(4, 12288)).toBe(3)
  })

  it('scales down safely on constrained 2 vCPU / 4 GB RAM hosts', () => {
    expect(computeDefaultConcurrency(2, 4096)).toBe(1)
  })

  it('scales up on larger hosts while leaving 1 vCPU for OS/dashboard', () => {
    expect(computeDefaultConcurrency(16, 65536)).toBe(15)
  })

  it('enforces priority order (critical > high > normal > low) and per-agent serialization', async () => {
    const gov = new FleetGovernor()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => { releaseFirst = r })

    // Occupy agent-a with a running turn
    const p1 = gov.enqueue({
      agentKey: 'agent-a',
      priority: 'normal',
      run: async () => {
        order.push('a1:start')
        await firstGate
        order.push('a1:end')
        return 'a1'
      },
    })

    // Enqueue a second turn for agent-a (must wait for a1:end even if slots are free)
    const p2 = gov.enqueue({
      agentKey: 'agent-a',
      priority: 'critical',
      run: async () => {
        order.push('a2')
        return 'a2'
      },
    })

    // Enqueue low and critical for agent-b and agent-c
    const p3 = gov.enqueue({
      agentKey: 'agent-b',
      priority: 'low',
      run: async () => {
        order.push('b-low')
        return 'b-low'
      },
    })
    const p4 = gov.enqueue({
      agentKey: 'agent-c',
      priority: 'critical',
      run: async () => {
        order.push('c-crit')
        return 'c-crit'
      },
    })

    // Let microtasks run before releasing a1
    await new Promise((r) => setTimeout(r, 20))
    expect(order).not.toContain('a2')
    releaseFirst()

    await Promise.all([p1, p2, p3, p4])
    expect(order.indexOf('a1:end')).toBeLessThan(order.indexOf('a2'))
  })

  it('cancels queued turns cleanly when an agent is stopped', async () => {
    const gov = new FleetGovernor()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })

    const p1 = gov.enqueue({
      agentKey: 'agent-x',
      priority: 'normal',
      run: async () => {
        await gate
        return 'ok'
      },
    })
    const p2 = gov.enqueue({
      agentKey: 'agent-x',
      priority: 'normal',
      run: async () => 'should-not-run',
    })

    const cancelled = gov.cancelAgent('agent-x')
    expect(cancelled).toBeGreaterThanOrEqual(1)
    await expect(p2).rejects.toThrow(/Turn cancelled/)
    release()
    await expect(p1).resolves.toBe('ok')
  })
})

describe('Headless Non-Tmux Runner', () => {
  it('selects headless mode for local codex and agy, and keeps tmux for claude / remote / opt-out', () => {
    expect(shouldUseHeadlessMode('codex')).toBe(true)
    expect(shouldUseHeadlessMode('agy')).toBe(true)
    expect(shouldUseHeadlessMode('claude')).toBe(false)
    expect(shouldUseHeadlessMode('codex', { host: 'laptop' })).toBe(false)
    expect(shouldUseHeadlessMode('agy', { executionMode: 'tmux' })).toBe(false)
    expect(shouldUseHeadlessMode('codex', { env: { MARVEEN_NON_CLAUDE_TMUX: '1' } })).toBe(false)
  })

  it('strips Anthropic credentials and caps Node heap in child env', () => {
    const env = buildHeadlessChildEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-keep',
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe('sk-openai-keep')
    expect(env.NO_COLOR).toBe('1')
    expect(env.TERM).toBe('dumb')
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=1536')
  })

  it('builds safe codex exec and resume specs using stdin', () => {
    const init = buildHeadlessTurnSpec({
      cliType: 'codex',
      bin: '/usr/local/bin/codex',
      cleanModel: 'gpt-5.4',
      prompt: 'hello world',
      skipPermissions: true,
      threadId: null,
      hasPriorTurn: false,
    })
    expect(init.args).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.4', '-'])
    expect(init.stdinText).toBe('hello world')

    const resumed = buildHeadlessTurnSpec({
      cliType: 'codex',
      bin: '/usr/local/bin/codex',
      cleanModel: 'gpt-5.4',
      prompt: 'follow up',
      skipPermissions: false,
      threadId: 'thr_123',
      hasPriorTurn: true,
    })
    expect(resumed.args).toEqual(['exec', 'resume', 'thr_123', '--json', '--sandbox', 'workspace-write', '-m', 'gpt-5.4', '-'])
  })

  it('builds safe agy -p specs and handles large prompts via 0600 temp file', () => {
    const small = buildHeadlessTurnSpec({
      cliType: 'agy',
      bin: '/usr/local/bin/agy',
      cleanModel: 'gemini-3-pro',
      prompt: 'fix bug',
      skipPermissions: true,
      threadId: null,
      hasPriorTurn: true,
    })
    expect(small.args).toEqual(['--continue', '--dangerously-skip-permissions', '--model', 'gemini-3-pro', '-p', 'fix bug'])
    expect(small.tempPromptFile).toBeNull()

    const bigPrompt = 'x'.repeat(20_000)
    const big = buildHeadlessTurnSpec({
      cliType: 'agy',
      bin: '/usr/local/bin/agy',
      cleanModel: 'gemini-3-pro',
      prompt: bigPrompt,
      skipPermissions: false,
      threadId: null,
      hasPriorTurn: false,
    })
    expect(big.tempPromptFile).toBeTruthy()
    expect(existsSync(big.tempPromptFile!)).toBe(true)
    expect(readFileSync(big.tempPromptFile!, 'utf-8')).toBe(bigPrompt)
    rmSync(big.tempPromptFile!, { force: true })
  })

  it('registers, captures deterministic pane state, and unregisters headless agents with 0 tmux', () => {
    registerHeadlessAgent({
      name: 'test-agy',
      session: 'agent-test-agy',
      cliType: 'agy',
      model: 'agy:gemini-3-pro',
      dir: '/tmp',
      skipPermissions: true,
      fresh: true,
    })
    expect(isHeadlessAgent('test-agy')).toBe(true)
    expect(isHeadlessSession('agent-test-agy')).toBe(true)

    const pane = captureHeadlessPane('agent-test-agy')
    expect(pane).toContain('[headless · agy · gemini-3-pro')
    expect(pane).toContain('[marveen-headless:idle]')
    expect(detectPaneState(pane!)).toBe('idle')

    const busyPane = pane!.replace('[marveen-headless:idle]', '[marveen-headless:busy]')
    expect(detectPaneState(busyPane)).toBe('busy')

    expect(unregisterHeadlessAgent('test-agy')).toBe(true)
    expect(isHeadlessAgent('test-agy')).toBe(false)
    expect(isHeadlessSession('agent-test-agy')).toBe(false)
    expect(captureHeadlessPane('agent-test-agy')).toBeNull()
  })

  it('executes real codex JSONL and agy headless subprocess turns end-to-end without tmux', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'marveen-headless-e2e-'))
    const origPath = process.env.PATH
    try {
      const codexMock = join(binDir, 'codex')
      writeFileSync(
        codexMock,
        `#!${process.execPath}
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_e2e_42' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex-ok:' + args.join(',') + ':' + input.trim() } }));
});
`,
      )
      chmodSync(codexMock, 0o755)

      const agyMock = join(binDir, 'agy')
      writeFileSync(
        agyMock,
        `#!${process.execPath}
const args = process.argv.slice(2);
console.log('agy-ok:' + args.join('|'));
`,
      )
      chmodSync(agyMock, 0o755)

      process.env.PATH = `${binDir}:${origPath ?? ''}`

      // 1. Codex two-turn flow: first exec, then resume thr_e2e_42
      registerHeadlessAgent({
        name: 'e2e-codex',
        session: 'agent-e2e-codex',
        cliType: 'codex',
        model: 'codex:gpt-5.4',
        dir: binDir,
        skipPermissions: true,
        fresh: true,
      })

      const t1 = await enqueueHeadlessPrompt('agent-e2e-codex', 'first prompt')
      expect(t1.ok).toBe(true)
      expect(t1.text).toContain('codex-ok:exec,--json,--dangerously-bypass-approvals-and-sandbox,-m,gpt-5.4,-:first prompt')

      const t2 = await enqueueHeadlessPrompt('agent-e2e-codex', 'second prompt')
      expect(t2.ok).toBe(true)
      expect(t2.text).toContain('codex-ok:exec,resume,thr_e2e_42,--json')
      expect(captureHeadlessPane('agent-e2e-codex')).toContain('turns: 2')
      unregisterHeadlessAgent('e2e-codex')

      // 2. Agy worker turn
      const w1 = await runHeadlessWorkerTurn({
        cliType: 'agy',
        model: 'agy:gemini-3-pro',
        dir: binDir,
        prompt: 'summarize',
        timeoutMs: 10_000,
      })
      expect(w1.ok).toBe(true)
      expect(w1.text).toContain('agy-ok:--dangerously-skip-permissions|--model|gemini-3-pro|-p|summarize')
    } finally {
      process.env.PATH = origPath
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('bounds 6 concurrent headless agents cleanly via FleetGovernor', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'marveen-headless-conc-'))
    const origPath = process.env.PATH
    const origMax = process.env.MARVEEN_MAX_CONCURRENT_TURNS
    try {
      const agyMock = join(binDir, 'agy')
      writeFileSync(
        agyMock,
        `#!${process.execPath}
setTimeout(() => { console.log('done'); }, 40);
`,
      )
      chmodSync(agyMock, 0o755)
      process.env.PATH = `${binDir}:${origPath ?? ''}`
      process.env.MARVEEN_MAX_CONCURRENT_TURNS = '2'

      const names = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
      for (const n of names) {
        registerHeadlessAgent({
          name: n,
          session: `agent-${n}`,
          cliType: 'agy',
          model: 'agy:gemini-3-pro',
          dir: binDir,
          skipPermissions: true,
          fresh: true,
        })
      }

      let peakActive = 0
      const sampler = setInterval(() => {
        const s = fleetGovernor.getStats()
        if (s.activeCount > peakActive) peakActive = s.activeCount
      }, 10)

      const results = await Promise.all(names.map(n => enqueueHeadlessPrompt(`agent-${n}`, `task-${n}`)))
      clearInterval(sampler)

      expect(results.every(r => r.ok)).toBe(true)
      expect(peakActive).toBeLessThanOrEqual(2)
      for (const n of names) unregisterHeadlessAgent(n)
    } finally {
      process.env.PATH = origPath
      if (origMax === undefined) delete process.env.MARVEEN_MAX_CONCURRENT_TURNS
      else process.env.MARVEEN_MAX_CONCURRENT_TURNS = origMax
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})
