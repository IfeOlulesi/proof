#!/usr/bin/env node
// proof — a hook that only records what happened, for the dashboard: after a tool ran, in agents that keep an event
// log (agents/events.mjs). It has no output.
import { hookInput } from './agents/index.mjs';

hookInput('afterTool');
