import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GITHUB_DIR = join(ROOT, '.github')
const WORKFLOWS_DIR = join(GITHUB_DIR, 'workflows')

function parseYaml(filePath: string): Record<string, any> {
  return parse(readFileSync(filePath, 'utf8'))
}

describe('GitHub Actions CI/CD and Dependabot security contracts', () => {
  const workflowFiles = readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()

  it('parses every workflow and dependabot config as valid YAML', () => {
    expect(workflowFiles).toEqual(
      expect.arrayContaining(['docker-image.yml', 'secret-gate.yml', 'security.yml', 'test.yml']),
    )
    for (const file of workflowFiles) {
      const parsed = parseYaml(join(WORKFLOWS_DIR, file))
      expect(parsed).toBeTruthy()
      expect(typeof parsed.jobs).toBe('object')
    }
    const dependabot = parseYaml(join(GITHUB_DIR, 'dependabot.yml'))
    expect(dependabot.version).toBe(2)
  })

  it('pins every third-party GitHub Action to a full 40-char commit SHA with version comment and avoids compromised Trivy tags', () => {
    const shaPinRe = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[0-9a-f]{40}$/
    for (const file of workflowFiles) {
      const path = join(WORKFLOWS_DIR, file)
      const raw = readFileSync(path, 'utf8')
      const doc = parseYaml(path)

      for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue
          expect(step.uses, `${file}:${jobId} uses ${step.uses}`).toMatch(shaPinRe)
        }
      }

      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(?:-\s*)?uses:\s*(.+)$/)
        if (!m) continue
        expect(line, `${file}: missing inline version comment on '${line.trim()}'`).toMatch(
          /@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/,
        )
        if (line.includes('aquasecurity/trivy-action@')) {
          const ver = line.match(/#\s+v(\d+)\.(\d+)\.(\d+)/)
          expect(ver).not.toBeNull()
          const minor = Number(ver![2])
          expect(Number(ver![1]) > 0 || minor >= 35).toBe(true)
        }
      }
    }
  })

  it('enforces top-level least-privilege read permissions and PR concurrency cancellation on all workflows', () => {
    for (const file of workflowFiles) {
      const doc = parseYaml(join(WORKFLOWS_DIR, file))
      expect(doc.permissions, `${file} must declare top-level permissions`).toEqual({ contents: 'read' })
      expect(doc.concurrency, `${file} must declare top-level concurrency`).toBeDefined()
      expect(String(doc.concurrency['cancel-in-progress'])).toContain('pull_request')
    }
  })

  it('wires security checks (npm audit, dependency-review, trivy-fs, codeql) and dependabot protections', () => {
    const security = parseYaml(join(WORKFLOWS_DIR, 'security.yml'))
    expect(Object.keys(security.jobs)).toEqual(
      expect.arrayContaining(['npm-audit', 'dependency-review', 'trivy-fs', 'codeql']),
    )

    const dependabot = parseYaml(join(GITHUB_DIR, 'dependabot.yml'))
    const npmUpdate = dependabot.updates.find((u: any) => u['package-ecosystem'] === 'npm')
    const dockerUpdate = dependabot.updates.find((u: any) => u['package-ecosystem'] === 'docker')
    const actionsUpdate = dependabot.updates.find((u: any) => u['package-ecosystem'] === 'github-actions')
    expect(npmUpdate).toBeDefined()
    expect(dockerUpdate).toBeDefined()
    expect(actionsUpdate).toBeDefined()
    expect(npmUpdate.cooldown?.['default-days']).toBeGreaterThanOrEqual(3)
    expect(npmUpdate.ignore).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'dependency-name': 'typescript',
          versions: ['>= 7.0.0'],
        }),
      ]),
    )
  })

  it('wires build, syntax-check, canonical lockfile, browser-verify, container Trivy scan, SBOM/provenance, and release jobs', () => {
    const testDoc = parseYaml(join(WORKFLOWS_DIR, 'test.yml'))
    const testRuns = (testDoc.jobs.test.steps as any[]).map(s => String(s.run ?? '')).join('\n')
    expect(testRuns).toContain('npm run syntax-check')
    expect(testRuns).toContain('npm run build')
    expect(testRuns).toContain('node --check "dist/web-assets/$asset"')
    expect(testRuns).toContain("import './dist/web.js'")
    expect(testRuns).toContain('bash scripts/check-lockfile-canonical.sh')
    const browserRuns = (testDoc.jobs['browser-verify'].steps as any[]).map(s => String(s.run ?? '')).join('\n')
    expect(browserRuns).toContain('npm run browser-verify')

    const dockerDoc = parseYaml(join(WORKFLOWS_DIR, 'docker-image.yml'))
    const buildTrivy = (dockerDoc.jobs.build.steps as any[]).find(
      s => typeof s.uses === 'string' && s.uses.startsWith('aquasecurity/trivy-action@'),
    )
    expect(buildTrivy).toBeDefined()
    expect(buildTrivy.with['scan-type']).toBe('image')
    expect(buildTrivy.with['exit-code']).toBe('1')

    const pushStep = (dockerDoc.jobs.publish.steps as any[]).find(s => s.id === 'push')
    expect(pushStep.with.sbom).toBe(true)
    expect(pushStep.with.provenance).toBe('mode=max')

    expect(dockerDoc.jobs.release).toBeDefined()
    expect(dockerDoc.jobs.release.permissions).toEqual({ contents: 'write' })
    expect(dockerDoc.jobs.release.needs).toEqual(['build', 'publish'])
  })
})
