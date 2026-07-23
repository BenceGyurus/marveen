import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveFromPath } from './platform.js'
import { logger } from './logger.js'

export type AgentCliType = 'agy' | 'codex' | 'claude'

export interface DetectedCli {
  type: AgentCliType
  binPath: string
  defaultModel?: string
}

let cachedCli: DetectedCli | null = null

function extractModelFromConfig(cliType: AgentCliType): string | undefined {
  try {
    if (cliType === 'claude' || cliType === 'codex' || cliType === 'agy') {
      // Typically stored in ~/.{cliType}/settings.json
      // Codex might use .codex, agy might use .agy or .antigravity
      const configDirName = cliType === 'agy' ? '.antigravity' : `.${cliType}`
      const configPath = join(homedir(), configDirName, 'settings.json')
      
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        if (config && config.model) {
          return config.model
        }
      }
    }
  } catch (err) {
    logger.debug({ err, cliType }, 'Could not read model from CLI config')
  }
  return undefined
}

export function detectAgentCli(): DetectedCli {
  if (cachedCli) return cachedCli

  const clis: AgentCliType[] = ['agy', 'codex', 'claude']
  
  for (const cli of clis) {
    try {
      const binPath = resolveFromPath(cli)
      if (binPath) {
        let defaultModel = process.env.MARVEEN_WORKER_MODEL || extractModelFromConfig(cli)
        
        logger.info({ cli, binPath, defaultModel }, 'Detected agent CLI')
        cachedCli = { type: cli, binPath, defaultModel }
        return cachedCli
      }
    } catch (err) {
      // CLI not found, continue to next
    }
  }

  logger.warn('No supported agent CLI (agy, codex, claude) found in PATH. Falling back to claude.')
  cachedCli = { type: 'claude', binPath: 'claude' }
  return cachedCli
}

export function getModelsFromCli(cli: DetectedCli): Array<{id: string, label: string}> | null {
  try {
    // Attempt standard JSON output
    try {
      const out = execSync(`${cli.binPath} models --json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
      const data = JSON.parse(out)
      if (Array.isArray(data)) {
        return data.map((m: any) => ({
          id: m.id || m.name,
          label: m.label || m.displayName || m.name || m.id
        }))
      }
    } catch (e) {
      // Fall through to plain text parsing
    }

    const out = execSync(`${cli.binPath} models`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    
    const models = lines
      .filter(l => !l.startsWith('---') && !l.startsWith('===') && !l.includes('ID')) // Skip headers
      .map(l => {
        const match = l.match(/^([a-zA-Z0-9.\-_]+)(?:\s+[-|:]\s+|\s+)(.*)$/)
        if (match) {
          return { id: match[1], label: match[2] ? `${match[2]} (${match[1]})` : match[1] }
        }
        return { id: l.split(/\s+/)[0], label: l }
      })
    
    return models.length > 0 ? models : null
  } catch (err) {
    logger.debug({ err, cli: cli.type }, 'Could not read models from CLI')
    return null
  }
}
