#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DEFAULT_FROZEN_CONFIG } from '../../scripts/multilogue-v2/blind/generate-frozen-v23-blind-draft.mjs';

assert.match(DEFAULT_FROZEN_CONFIG, /specs\/multilogue-v2\/l1b-frozen-method-config-v2\.3\.json$/);
assert.equal(fs.existsSync(DEFAULT_FROZEN_CONFIG), true, 'tracked L1b method config must exist');

const config = JSON.parse(fs.readFileSync(DEFAULT_FROZEN_CONFIG, 'utf8'));
assert.equal(config.adapter.phraseGapSeconds, 0.35);
assert.equal(config.adapter.acousticThresholdMarginDb, 5);
assert.equal(config.backchannel.mode, 'explicit_plus_acoustic');
assert.equal(config.filler.mode, 'acoustic_cell');

console.log('PASS L1b frozen method config is tracked and production-readable');
