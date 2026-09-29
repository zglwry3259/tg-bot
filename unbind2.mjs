
import { kvDel, kvGet } from './src/kv-store.js';

await kvDel('lucky_bind:7027439863');
console.log('deleted');
console.log('check:', await kvGet('lucky_bind:7027439863'));
