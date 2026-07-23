import { ChromaClient, Collection } from 'chromadb'
import { logger } from './logger.js'

let client: ChromaClient | null = null
let collection: Collection | null = null

export async function initVectorStore(): Promise<void> {
  try {
    // In a real enterprise setup, URL would be read from env vars
    client = new ChromaClient({ path: process.env.CHROMA_URL || 'http://localhost:8000' })
    
    collection = await client.getOrCreateCollection({
      name: 'marveen_memories',
      metadata: { "hnsw:space": "cosine" }
    })
    logger.info('ChromaDB vector store initialized successfully.')
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize ChromaDB. Make sure Chroma server is running.')
    client = null
    collection = null
  }
}

export async function addVectorMemory(id: string, text: string, metadata?: Record<string, any>): Promise<void> {
  if (!collection) return
  
  try {
    await collection.add({
      ids: [id],
      documents: [text],
      metadatas: [metadata || {}]
    })
    logger.debug({ id }, 'Added memory to ChromaDB')
  } catch (err) {
    logger.error({ err, id }, 'Error adding memory to ChromaDB')
  }
}

export async function queryVectorMemory(queryText: string, limit: number = 5): Promise<any[]> {
  if (!collection) return []
  
  try {
    const results = await collection.query({
      queryTexts: [queryText],
      nResults: limit
    })
    
    // Format results to a standardized array
    if (results && results.documents && results.documents[0]) {
      return results.documents[0].map((doc, idx) => ({
        id: results.ids[0][idx],
        content: doc,
        metadata: results.metadatas && results.metadatas[0] ? results.metadatas[0][idx] : {}
      }))
    }
  } catch (err) {
    logger.error({ err }, 'Error querying ChromaDB')
  }
  return []
}

export async function deleteVectorMemory(id: string): Promise<void> {
  if (!collection) return
  try {
    await collection.delete({
      ids: [id]
    })
  } catch (err) {
    logger.error({ err, id }, 'Error deleting memory from ChromaDB')
  }
}
