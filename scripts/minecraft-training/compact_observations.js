'use strict';
const fs = require('fs');
const { compactObservation } = require('../../src/minecraft/survival-planner');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.map(compactObservation)));
