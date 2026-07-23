import { detectAgentCli, getSupportedModels } from './src/cli-detector.js'
console.log('CLI:', detectAgentCli())
console.log('agy models:', getSupportedModels('agy'))
