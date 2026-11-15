import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  ensureUniversalInstructionFiles,
  prepareWorkspaceForCli,
  readInstructionFile,
  resolveInstructionFilePath,
  writeUniversalInstructionFile,
} from '../cli-detector.js'
import { runAgent, runViaNonClaudeCli } from '../agent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'

function runBash(script: string, cwd = ROOT): string {
  return execFileSync(BASH, ['-eu', '-c', script], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      LANG: 'C.UTF-8',
    },
    encoding: 'utf-8',
  })
}

describe('sync_universal_instruction_files (scripts/lib/persona-template.sh)', () => {
  const lib = join(ROOT, 'scripts', 'lib', 'persona-template.sh')

  it('keeps AGENTS.md canonical and links GEMINI.md + CLAUDE.md -> AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'univ-sync-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# Canonical instructions\n')
      runBash(`. ${JSON.stringify(lib)}; sync_universal_instruction_files ${JSON.stringify(dir)}`)

      expect(lstatSync(join(dir, 'AGENTS.md')).isFile()).toBe(true)
      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(lstatSync(join(dir, 'GEMINI.md')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readFileSync(join(dir, 'GEMINI.md'), 'utf-8')).toBe('# Canonical instructions\n')
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Canonical instructions\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates legacy regular CLAUDE.md to AGENTS.md and supports promote-claudemd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'univ-promote-'))
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# Legacy rules\n')
      runBash(`. ${JSON.stringify(lib)}; sync_universal_instruction_files ${JSON.stringify(dir)}`)
      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# Legacy rules\n')
      expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')

      // Overwriting CLAUDE.md as a regular file and promoting replaces canonical AGENTS.md cleanly
      rmSync(join(dir, 'CLAUDE.md'))
      writeFileSync(join(dir, 'CLAUDE.md'), '# Freshly rendered\n')
      runBash(`. ${JSON.stringify(lib)}; sync_universal_instruction_files ${JSON.stringify(dir)} promote-claudemd`)
      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# Freshly rendered\n')
      expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installers and update.sh universal instruction & SOUL.md healing', () => {
  it('installers create universal instruction links and check non-empty SOUL.md', () => {
    for (const file of ['install-linux.sh', 'install-macos.sh', 'docker/first-boot.sh']) {
      const content = readFileSync(join(ROOT, file), 'utf-8')
      expect(content).toContain('sync_universal_instruction_files')
      expect(content).toContain('SOUL.md')
    }
    const updateSh = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    expect(updateSh).toContain('--regen-claudemd|--regen-agentsmd|--regen-persona')
    expect(updateSh).toContain('ensure_universal_persona_files')
  })

  it('update.sh ensure_universal_persona_files migrates CLAUDE.md, heals missing/empty SOUL.md for root & sub-agents, without clobbering existing edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'univ-update-'))
    try {
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
      mkdirSync(join(dir, 'templates'), { recursive: true })
      mkdirSync(join(dir, 'agents', 'alpha'), { recursive: true })
      mkdirSync(join(dir, 'agents', 'beta'), { recursive: true })
      for (const f of ['persona-template.sh', 'install-tz.sh', 'seed-refresh.sh']) {
        cpSync(join(ROOT, 'scripts', 'lib', f), join(dir, 'scripts', 'lib', f))
      }
      cpSync(join(ROOT, 'templates', 'CLAUDE.md.template'), join(dir, 'templates', 'CLAUDE.md.template'))
      cpSync(join(ROOT, 'templates', 'SOUL.md.template'), join(dir, 'templates', 'SOUL.md.template'))

      writeFileSync(
        join(dir, '.env'),
        'OWNER_NAME=Bence Test\nBOT_NAME=MarveenBot\nMAIN_AGENT_ID=marveen\nAGENT_TEXT_LANG=hu\n',
      )
      // Root: legacy CLAUDE.md, empty 0-byte SOUL.md
      writeFileSync(join(dir, 'CLAUDE.md'), '# Custom Root Instructions\n')
      writeFileSync(join(dir, 'SOUL.md'), '')

      // Sub-agent alpha: legacy CLAUDE.md, missing SOUL.md
      writeFileSync(join(dir, 'agents', 'alpha', 'CLAUDE.md'), '# Alpha rules\n')

      // Sub-agent beta: existing SOUL.md (must not be clobbered) and canonical AGENTS.md
      writeFileSync(join(dir, 'agents', 'beta', 'AGENTS.md'), '# Beta canonical\n')
      writeFileSync(join(dir, 'agents', 'beta', 'SOUL.md'), '# Custom Beta Soul\n')

      const updateSrc = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
      const fnStart = updateSrc.indexOf('_up_env_val() {')
      const fnEnd = updateSrc.indexOf('\n# Scheduled-task registry:', fnStart)
      expect(fnStart).toBeGreaterThan(-1)
      expect(fnEnd).toBeGreaterThan(fnStart)
      const fnBlock = updateSrc.slice(fnStart, fnEnd)

      const script = [
        `INSTALL_DIR=${JSON.stringify(dir)}`,
        'GREEN=""; NC=""; ORANGE=""; RED=""',
        `. ${JSON.stringify(join(dir, 'scripts', 'lib', 'seed-refresh.sh'))}`,
        fnBlock,
        'ensure_universal_persona_files',
      ].join('\n')

      runBash(script, dir)

      // Root migrated and healed
      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# Custom Root Instructions\n')
      expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')
      const rootSoul = readFileSync(join(dir, 'SOUL.md'), 'utf-8')
      expect(rootSoul.length).toBeGreaterThan(20)
      expect(rootSoul).toContain('MarveenBot')
      expect(rootSoul).toContain('Bence Test')

      // Alpha migrated and got starter SOUL.md
      expect(lstatSync(join(dir, 'agents', 'alpha', 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'agents', 'alpha', 'AGENTS.md'), 'utf-8')).toBe('# Alpha rules\n')
      expect(readlinkSync(join(dir, 'agents', 'alpha', 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'agents', 'alpha', 'GEMINI.md'))).toBe('AGENTS.md')
      const alphaSoul = readFileSync(join(dir, 'agents', 'alpha', 'SOUL.md'), 'utf-8')
      expect(alphaSoul).toContain('alpha')

      // Beta kept existing custom SOUL.md and got symlinks
      expect(readFileSync(join(dir, 'agents', 'beta', 'SOUL.md'), 'utf-8')).toBe('# Custom Beta Soul\n')
      expect(readlinkSync(join(dir, 'agents', 'beta', 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'agents', 'beta', 'GEMINI.md'))).toBe('AGENTS.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cli-detector universal instruction helpers', () => {
  it('writes canonical AGENTS.md with CLAUDE.md + GEMINI.md symlinks and avoids symlink loops in prepareWorkspaceForCli', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-univ-'))
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# Old CLAUDE\n')
      writeUniversalInstructionFile(dir, '# New Universal Rules\n')

      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# New Universal Rules\n')
      expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# New Universal Rules\n')
      expect(resolveInstructionFilePath(dir)).toBe(join(dir, 'AGENTS.md'))
      expect(readInstructionFile(dir)).toBe('# New Universal Rules\n')

      // Ensure no temp files leaked
      expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])

      // prepareWorkspaceForCli should NOT turn canonical AGENTS.md into a self-loop
      prepareWorkspaceForCli(dir, 'codex')
      prepareWorkspaceForCli(dir, 'agy')
      expect(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# New Universal Rules\n')

      // Broken symlink heals cleanly
      rmSync(join(dir, 'GEMINI.md'))
      symlinkSync('MISSING.md', join(dir, 'GEMINI.md'))
      ensureUniversalInstructionFiles(dir)
      expect(readlinkSync(join(dir, 'GEMINI.md'))).toBe('AGENTS.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('agent.ts non-Claude headless CLI support (codex & agy)', () => {
  it('runViaNonClaudeCli executes codex exec with sanitized env and captures final message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mock-codex-'))
    const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-oauth-should-strip'
      process.env.ANTHROPIC_API_KEY = 'secret-anthropic-should-strip'

      const captureFile = join(tmp, 'captured.txt')
      const mockCodex = join(tmp, 'codex')
      writeFileSync(
        mockCodex,
        `#!/bin/sh
OUT=""
ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
PROMPT="$(cat)"
printf 'ARGS=%s\\nPROMPT=%s\\nOAUTH=%s\\nAKEY=%s\\n' "$ARGS" "$PROMPT" "\${CLAUDE_CODE_OAUTH_TOKEN:-}" "\${ANTHROPIC_API_KEY:-}" > ${JSON.stringify(captureFile)}
printf '# Generated SOUL\\nYou are Codex Agent.\\n' > "$OUT"
`,
      )
      chmodSync(mockCodex, 0o755)

      const res = await runViaNonClaudeCli('codex', 'Generate SOUL.md now', {
        cwd: tmp,
        model: 'codex:gpt-5.3-codex',
        binPath: mockCodex,
        timeoutMs: 10_000,
      })

      expect(res.error).toBeUndefined()
      expect(res.text).toBe('# Generated SOUL\nYou are Codex Agent.')

      const captured = readFileSync(captureFile, 'utf-8')
      expect(captured).toContain('exec --skip-git-repo-check --sandbox read-only --color never -m gpt-5.3-codex --output-last-message')
      expect(captured).toContain('PROMPT=Generate SOUL.md now')
      expect(captured).toContain('OAUTH=\n')
      expect(captured).toContain('AKEY=\n')
    } finally {
      if (prevOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevAnthropic
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('runAgent routes through agy CLI cleanly when configured with agy model', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mock-agy-'))
    const prevPath = process.env.PATH ?? ''
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'secret-anthropic-should-strip'
      const captureFile = join(tmp, 'agy-captured.txt')
      const mockAgy = join(tmp, 'agy')
      writeFileSync(
        mockAgy,
        `#!/bin/sh
printf 'ARGS=%s\\nVIEW=%s\\nAKEY=%s\\n' "$*" "\${CLAUDE_CODE_DISABLE_AGENT_VIEW:-}" "\${ANTHROPIC_API_KEY:-}" > ${JSON.stringify(captureFile)}
printf '# Generated AGENTS.md\\nRole: Assistant\\n'
`,
      )
      chmodSync(mockAgy, 0o755)

      process.env.PATH = `${tmp}:${prevPath}`
      const res = await runAgent(
        'Generate AGENTS.md',
        undefined,
        undefined,
        false,
        tmp,
        undefined,
        {
          cliType: 'agy',
          model: 'agy:gemini-2.5-pro',
          timeoutMs: 10_000,
        },
      )

      expect(res.error).toBeUndefined()
      expect(res.text).toBe('# Generated AGENTS.md\nRole: Assistant')
      const captured = readFileSync(captureFile, 'utf-8')
      expect(captured).toContain('-p Generate AGENTS.md --output-format text --dangerously-skip-permissions --model gemini-2.5-pro')
      expect(captured).toContain('VIEW=1')
      expect(captured).toContain('AKEY=\n')
    } finally {
      process.env.PATH = prevPath
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevAnthropic
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
