export {
  lifeEvents,
  embeddingSync,
  goals,
  triggerLog,
  integrationSync,
} from './schema.js';

export { deriveKey, encryptPayload, decryptPayload } from './encrypt.js';

export { createWriter, type MemoryWriter, type BatchWriteResult } from './writer.js';

export {
  createReader,
  type MemoryReader,
  type Goal,
  type TriggerLogEntry,
} from './reader.js';
