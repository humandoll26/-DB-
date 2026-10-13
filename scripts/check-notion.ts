import { readConfig } from '../server/config.js';
import { NotionRepository } from '../server/repository.js';
const config = readConfig();
if (config.mode !== 'notion') throw new Error('STORAGE_MODE=notionに設定してください');
console.log(await new NotionRepository(config).check());
