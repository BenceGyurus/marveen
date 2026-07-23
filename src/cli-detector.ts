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
