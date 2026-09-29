
import LOTTERY_KV from './src/kv-store.js';

await LOTTERY_KV.delete('lucky_bind:7027439863');
console.log('deleted');
console.log('check:', await LOTTERY_KV.get('lucky_bind:7027439863'));
