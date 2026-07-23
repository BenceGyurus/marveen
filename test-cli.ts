import { getSupportedModels, getModelsFromCli } from './src/cli-detector.js'
import { tryResolveFromPath } from './src/platform.js'

console.log('Resolving agy:', tryResolveFromPath('agy'))
console.log('Models:', getSupportedModels('agy'))
