#!/usr/bin/env node
/**
 * handoff — the context-handoff CLI. Productizes the hand-written
 * ~/projects/.<repo>-handoff-*.md ritual into a structured, resumable artifact.
 *
 *   handoff new --project sitelayer --title "Sitelayer — Agent Handoff" [--out handoff.json]
 *   handoff validate <handoff.json>
 *   handoff show <handoff.json>            # render the human markdown view
 *   handoff resume <handoff.json>          # print the paste-ready next-agent prompt
 *
 * Depends only on this package's dist (run `npm run build` first).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  newHandoff,
  serializeHandoff,
  parseHandoff,
  validateHandoff,
  handoffToMarkdown,
  handoffToResumePrompt,
} from '../dist/handoff.js';

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const [cmd, maybeFile] = process.argv.slice(2);

switch (cmd) {
  case 'new': {
    const project = arg('--project');
    const title = arg('--title', project ? `${project} — Agent Handoff` : undefined);
    if (!project) die('handoff new: --project is required');
    const h = newHandoff(project, title);
    h.summary = 'TODO: one-paragraph "where we are / what you are taking over".';
    h.environment.repo = arg('--repo', `~/projects/${project}`);
    h.environment.hard_rules = ['TODO: project-specific hard rules (e.g. required env prefixes, "PROD never auto-deploys").'];
    h.live_state = ['TODO: verifiable current-state bullets (SHAs, live URLs, what landed).'];
    h.gotchas = [{ note: 'TODO: the thing that will bite the next agent.', severity: 'warn' }];
    const out = arg('--out');
    const json = serializeHandoff(h);
    if (out) {
      writeFileSync(out, json);
      console.error(`wrote ${out}`);
    } else {
      process.stdout.write(json);
    }
    break;
  }
  case 'validate': {
    if (!maybeFile) die('handoff validate <file>');
    const problems = validateHandoff(JSON.parse(readFileSync(maybeFile, 'utf8')));
    if (problems.length) die('INVALID:\n' + problems.map((p) => ` - ${p}`).join('\n'));
    console.error('OK — valid handoff');
    break;
  }
  case 'show': {
    if (!maybeFile) die('handoff show <file>');
    process.stdout.write(handoffToMarkdown(parseHandoff(readFileSync(maybeFile, 'utf8'))) + '\n');
    break;
  }
  case 'resume': {
    if (!maybeFile) die('handoff resume <file>');
    process.stdout.write(handoffToResumePrompt(parseHandoff(readFileSync(maybeFile, 'utf8'))) + '\n');
    break;
  }
  default:
    die(
      [
        'handoff — context-handoff protocol CLI',
        '',
        '  handoff new --project <key> [--title T] [--repo P] [--out FILE]',
        '  handoff validate <handoff.json>',
        '  handoff show <handoff.json>      render markdown',
        '  handoff resume <handoff.json>    print the next-agent prompt',
      ].join('\n'),
      cmd ? 1 : 0,
    );
}
