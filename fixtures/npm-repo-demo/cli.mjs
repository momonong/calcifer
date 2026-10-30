import { readFileSync } from 'node:fs';
import { add } from './src/add.mjs';
const { a, b } = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(add(a, b)));
