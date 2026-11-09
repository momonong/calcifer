#!/usr/bin/env node
import { main } from '../src/calcifer-cli.mjs';
process.exitCode = process.argv[2]==='remote'
 ? await (await import('../src/remote-cli.mjs')).remoteMain()
 : await main();
